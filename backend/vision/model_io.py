"""Workspace-owned, bounded model I/O; durable settlement belongs to Tasks."""
import asyncio
from concurrent.futures import Future
from dataclasses import dataclass
import threading
import time

from . import provider


class RequestCancelled(ValueError):
    pass


@dataclass(frozen=True)
class Completion:
    response: object = None
    error: Exception | None = None
    duration_ms: float = 0


@dataclass
class Request:
    owner: tuple
    result: Future
    cancelled: bool = False


class ModelIO:
    def __init__(self, transport=None, capacity=2):
        if type(capacity) is not int or capacity < 1:
            raise ValueError('model I/O capacity must be a positive integer')
        self.transport = transport or provider.complete_async
        self.capacity = capacity
        self.lock = threading.Lock()
        self.requests = {}
        self.activities = {}  # Owned exclusively by the I/O loop.
        self.ready = threading.Event()
        self.thread = None
        self.loop = None
        self.closing = False
        self.failure = None

    def start(self):
        if self.thread is not None:
            raise RuntimeError('model I/O already started')
        self.thread = threading.Thread(target=self._run, name='vision-model-io', daemon=True)
        self.thread.start()
        if not self.ready.wait(10):
            self.cancel_all()
            raise RuntimeError('model I/O startup timed out')
        if self.failure:
            raise RuntimeError('model I/O startup failed') from self.failure

    def _run(self):
        try:
            asyncio.run(self._serve())
        except Exception as error:
            self.failure = error
        finally:
            with self.lock:
                self.closing = True
                for entry in self.requests.values():
                    if not entry.result.done():
                        entry.result.set_result(Completion(error=ValueError('model I/O stopped; request outcome may be unknown')))
            self.ready.set()

    async def _serve(self):
        self.loop = asyncio.get_running_loop()
        self.shutdown = asyncio.Event()
        async with provider.client() as client:
            self.client = client
            self.ready.set()
            if self.closing:
                self.shutdown.set()
            await self.shutdown.wait()
            activities = list(self.activities.values())
            for task in activities:
                task.cancel()
            await asyncio.gather(*activities, return_exceptions=True)

    def available(self):
        with self.lock:
            return not self.closing and len(self.requests) < self.capacity

    def submit(self, request_id, owner, payload):
        with self.lock:
            if self.closing or self.loop is None or len(self.requests) >= self.capacity:
                raise ValueError('model I/O unavailable')
            if request_id in self.requests:
                raise ValueError('duplicate model request identity')
            entry = Request(owner, Future())
            self.requests[request_id] = entry
            self.loop.call_soon_threadsafe(self._launch, request_id, entry, payload)

    def _launch(self, request_id, entry, payload):
        if entry.cancelled or self.closing:
            entry.result.set_result(Completion(error=RequestCancelled('model request cancelled before transmission')))
            return
        task = asyncio.create_task(self._execute(payload))
        self.activities[request_id] = task

        def settled(task):
            self.activities.pop(request_id, None)
            if task.cancelled():
                result = Completion(error=RequestCancelled('model request cancelled; outcome may be unknown'))
            else:
                result = task.result()
            entry.result.set_result(result)

        task.add_done_callback(settled)

    async def _execute(self, payload):
        started = time.monotonic()
        try:
            response = await asyncio.wait_for(self.transport(payload, self.client), timeout=180)
            return Completion(response=response, duration_ms=round((time.monotonic() - started) * 1000, 3))
        except asyncio.CancelledError:
            return Completion(error=RequestCancelled('model request cancelled; outcome may be unknown'),
                              duration_ms=round((time.monotonic() - started) * 1000, 3))
        except Exception as error:
            if not isinstance(error, (ValueError, OSError)):
                error = ValueError('model transport failed; outcome may be unknown, no automatic retry')
            return Completion(error=error, duration_ms=round((time.monotonic() - started) * 1000, 3))

    def take(self, request_id):
        with self.lock:
            entry = self.requests[request_id]
            if not entry.result.done():
                return None
            del self.requests[request_id]
            return entry.result.result()

    def cancel(self, request_id):
        with self.lock:
            entry = self.requests.get(request_id)
            if entry:
                entry.cancelled = True
                if self.loop and not self.loop.is_closed():
                    self.loop.call_soon_threadsafe(self._cancel, request_id)

    def _cancel(self, request_id):
        task = self.activities.get(request_id)
        if task:
            task.cancel()

    def cancel_owner(self, task_id, epoch):
        with self.lock:
            ids = [key for key, entry in self.requests.items() if entry.owner == (task_id, epoch)]
        for key in ids:
            self.cancel(key)

    def cancel_all(self):
        with self.lock:
            self.closing = True
            ids = list(self.requests)
        for key in ids:
            self.cancel(key)

    def close(self):
        self.cancel_all()
        if self.loop and self.thread.is_alive():
            self.loop.call_soon_threadsafe(self.shutdown.set)
        if self.thread and self.thread.ident is not None:
            self.thread.join(timeout=25)
            if self.thread.is_alive():
                raise RuntimeError('model I/O did not drain; controller ownership must be retained')

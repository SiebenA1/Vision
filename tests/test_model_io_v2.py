"""Controlled asynchronous model transport; no remote model calls."""
import asyncio
import threading
import time
import unittest

from backend.vision.model_io import ModelIO, RequestCancelled
import test_model_tasks_v2 as fixtures
from test_tasks_v2 import command

response = fixtures.response


class ModelIOTest(unittest.TestCase):
    def test_capacity_cancellation_cleanup_and_shared_client(self):
        entered, cleaned = threading.Event(), threading.Event()
        clients = []

        async def transport(payload, client):
            clients.append(client)
            if payload.get('wait'):
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cleaned.set()
            return {'id': 'done'}

        io = ModelIO(transport, capacity=2)
        io.start()
        try:
            io.submit('slow', ('task', 1), {'wait': True})
            self.assertTrue(entered.wait(2))
            io.submit('fast', ('other', 1), {})
            with self.assertRaises(ValueError):
                io.submit('overflow', ('third', 1), {})
            result = self.wait_result(io, 'fast')
            self.assertEqual(result.response, {'id': 'done'})
            self.assertIs(clients[0], clients[1])
            io.cancel_owner('task', 1)
            self.assertTrue(cleaned.wait(2))
            self.assertIsInstance(self.wait_result(io, 'slow').error, RequestCancelled)
        finally:
            io.close()
        self.assertFalse(io.thread.is_alive())
        self.assertTrue(io.client.is_closed)

    @staticmethod
    def wait_result(io, key):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            result = io.take(key)
            if result is not None:
                return result
            threading.Event().wait(.01)
        raise AssertionError('model request did not settle')

    def test_close_drains_active_transport_and_retains_completion(self):
        entered, cleaned = threading.Event(), threading.Event()

        async def transport(payload, client):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaned.set()

        io = ModelIO(transport)
        io.start()
        io.submit('pending', ('task', 1), {})
        self.assertTrue(entered.wait(2))
        io.close()
        self.assertTrue(cleaned.is_set())
        self.assertIsInstance(io.take('pending').error, RequestCancelled)
        self.assertFalse(io.available())
        io.close()


class AsyncModelTaskTest(unittest.TestCase):
    setUp = fixtures.ModelTaskTest.setUp
    create = fixtures.ModelTaskTest.create

    def tearDown(self):
        self.tasks.close()
        fixtures.ModelTaskTest.tearDown(self)

    def start_io(self, transport):
        self.tasks.model_io = ModelIO(transport)
        self.tasks.model_io.start()

    def advance_until(self, task, state):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            self.tasks.step(task)
            value = self.tasks.get(task)
            if value['state'] == state:
                return value
            threading.Event().wait(.01)
        self.fail(str(value))

    def test_slow_model_does_not_block_other_project_local_task(self):
        entered = threading.Event()

        async def transport(payload, client):
            entered.set()
            await asyncio.Event().wait()

        self.tasks.model_transport = transport
        self.tasks.start()
        slow = self.tasks.create(self.project, command('slow-model', expected_head=self.head,
            statement='只读证据', max_jobs=1, max_requests=2), model=True)['task_id']
        self.assertTrue(entered.wait(5))
        project = self.client.post('/api/v2/projects', json=command('other-project', name='Other')).json()
        local = self.tasks.create(project['project_id'], command('local', expected_head=project['revision_id'],
            statement='只读证据', max_jobs=1, plan=[{'tool': 'assessment', 'arguments': {}}]))['task_id']
        until = time.monotonic() + 5
        while time.monotonic() < until and self.tasks.get(local)['state'] != 'completed':
            threading.Event().wait(.02)
        self.assertEqual(self.tasks.get(local)['state'], 'completed')
        self.assertEqual(self.tasks.get(slow)['steps'][0]['state'], 'requesting_model')
        self.tasks.change(slow, command('stop', expected_epoch=1))

    def test_completion_is_settled_once_with_original_request_and_usage(self):
        async def transport(payload, client):
            return response('finish', {'summary': '当前无数值结论'}, 'async-call')

        self.start_io(transport)
        task = self.create()
        value = self.advance_until(task, 'completed')
        self.tasks.step(task)
        self.assertEqual(value['config']['used_tokens'], 15)
        self.assertEqual(len(value['steps']), 1)
        request = value['steps'][0]['response']['request']
        self.assertGreater(request['payload_bytes'], 0)
        self.assertIn('context', request['timings_ms'])
        with self.tasks.workspace.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM context_snapshots').fetchone()[0], 1)

    def test_correction_cancels_transport_and_cannot_execute_old_response(self):
        entered, cleaned = threading.Event(), threading.Event()

        async def transport(payload, client):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # Even a transport that settles late after cancellation is fenced.
                return response('finish', {'summary': 'obsolete'}, 'obsolete-call')
            finally:
                cleaned.set()

        self.start_io(transport)
        task = self.create()
        self.tasks.step(task)
        self.assertTrue(entered.wait(2))
        self.tasks.change(task, command('correct', expected_head=self.head, expected_epoch=1,
            statement='新请求', max_jobs=1, max_requests=2), correct=True, model=True)
        self.assertTrue(cleaned.wait(2))
        until = time.monotonic() + 2
        while self.tasks.model_requests and time.monotonic() < until:
            self.tasks.reconcile_requests()
            threading.Event().wait(.01)
        value = self.tasks.get(task)
        self.assertFalse(self.tasks.model_requests)
        self.assertEqual(value['epoch'], 2)
        self.assertEqual(value['state'], 'created')
        self.assertEqual(value['steps'][0]['state'], 'superseded')
        self.assertEqual(value['summary'], '')

    def test_shutdown_pauses_owned_request_without_replay(self):
        entered = threading.Event()

        async def transport(payload, client):
            entered.set()
            await asyncio.Event().wait()

        self.start_io(transport)
        task = self.create()
        self.tasks.step(task)
        self.assertTrue(entered.wait(2))
        self.tasks.close()
        value = self.tasks.get(task)
        self.assertEqual(value['state'], 'waiting_user')
        self.assertIn('outcome may be unknown', value['error'])

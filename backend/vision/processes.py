"""Exclusive controller ownership and termination of owned native process trees."""
import os
import signal


class ControllerLock:
    def __init__(self, path):
        self.file = path.open("a+b")
        if not path.stat().st_size:
            self.file.write(b"0")
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.file.close()
            raise RuntimeError("another controller owns this workspace") from error

    def close(self):
        self.file.close()


class ProcessTree:
    def __init__(self, process, memory_limit_mib=None):
        self.process = process
        self.handle = None
        if os.name != "nt":
            if memory_limit_mib is not None:
                process.kill()
                process.wait()
                raise ValueError("hard process-tree memory limits currently require Windows Job Objects")
            return
        import ctypes as c
        from ctypes import wintypes as w

        class Limits(c.Structure):
            _fields_ = [("process_time", c.c_longlong), ("job_time", c.c_longlong),
                        ("flags", w.DWORD), ("min_working_set", c.c_size_t),
                        ("max_working_set", c.c_size_t), ("active_processes", w.DWORD),
                        ("affinity", c.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]

        class IO(c.Structure):
            _fields_ = [(name, c.c_ulonglong) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

        class Extended(c.Structure):
            _fields_ = [("basic", Limits), ("io", IO), ("process_memory", c.c_size_t),
                        ("job_memory", c.c_size_t), ("peak_process", c.c_size_t), ("peak_job", c.c_size_t)]

        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = w.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
        self.kernel.SetInformationJobObject.restype = w.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = w.BOOL
        self.kernel.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.kernel.TerminateJobObject.restype = w.BOOL
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.kernel.CloseHandle.restype = w.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if memory_limit_mib is not None:
            if type(memory_limit_mib) is not int or not 64 <= memory_limit_mib <= 65536:
                process.kill()
                process.wait()
                self.close()
                raise ValueError("invalid process-tree memory budget")
            limits.basic.flags |= 0x200  # JOB_OBJECT_LIMIT_JOB_MEMORY: aggregate committed bytes.
            limits.job_memory = memory_limit_mib * 1024 * 1024
        if not self.handle or not self.kernel.SetInformationJobObject(self.handle, 9, c.byref(limits), c.sizeof(limits)) or not self.kernel.AssignProcessToJobObject(self.handle, w.HANDLE(int(process._handle))):
            error = c.WinError(c.get_last_error())
            process.kill()
            process.wait()
            self.close()
            raise error

    def terminate(self):
        if os.name == "nt":
            if not self.kernel.TerminateJobObject(self.handle, 1):
                import ctypes
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None

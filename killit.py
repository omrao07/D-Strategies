import os, signal
pids = [31417, 32248, 32749, 33166, 33269]
for pid in pids:
    try:
        os.kill(pid, signal.SIGKILL)
        print(f"killed {pid}")
    except Exception as e:
        print(f"failed {pid}: {e}")

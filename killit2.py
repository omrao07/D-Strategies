import os, signal, subprocess

result = subprocess.run(['ps', 'aux'], capture_output=True, text=True)
pids = []
for line in result.stdout.splitlines():
    if 'pytest' in line or ('Python' in line and 'pytest' in line):
        if 'grep' not in line and 'killit' not in line:
            parts = line.split()
            if parts:
                try:
                    pids.append(int(parts[1]))
                except ValueError:
                    pass

print(f"Found {len(pids)} python/pytest processes: {pids}")
for pid in pids:
    try:
        os.kill(pid, signal.SIGKILL)
        print(f"killed {pid}")
    except Exception as e:
        print(f"failed {pid}: {e}")

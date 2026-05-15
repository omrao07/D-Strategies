#!/bin/sh
# Kill all pytest/Python processes except this script's own shell
for pid in $(ps aux | grep -E "pytest|Python" | grep -v grep | grep -v killit | awk '{print $2}'); do
    kill -9 "$pid" 2>/dev/null && echo "killed $pid"
done
echo "Done killing processes"

# A job: some work, and whether this container ran a job before (a marker in its filesystem).
import json, os, sys
run = int(sys.argv[1])
total = sum(i % 7 for i in range(100_000))
fresh = not os.path.exists("/workspace/.ran")
with open("/workspace/.ran", "w") as f:
    f.write(str(run))
print(json.dumps({"run": run, "sum": total, "fresh": fresh, "engine": "wasmer"}))

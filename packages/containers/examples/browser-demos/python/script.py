import csv, platform, statistics

rows = list(csv.DictReader(open("/data/temperatures.csv")))
temps = [float(r["temp"]) for r in rows]
hottest = max(rows, key=lambda r: float(r["temp"]))
print(f"Python {platform.python_version()} on {platform.machine()}")
print(f"{len(rows)} cities, mean {statistics.mean(temps):.1f} °C, hottest: {hottest['city']}")

# a file written under /data lands in the page's FilesApi
with open("/data/summary.txt", "w") as f:
    f.write(f"cities={len(rows)}\nmean={statistics.mean(temps):.2f}\nhottest={hottest['city']}\n")
print("wrote /data/summary.txt")

# the container has no network
import socket
try:
    socket.create_connection(("example.com", 80), timeout=3)
    print("network: reachable")
except OSError as e:
    print(f"network: none ({type(e).__name__})")

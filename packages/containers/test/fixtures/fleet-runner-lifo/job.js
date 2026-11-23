// A job: some work, and whether this container ran a job before (a marker in its filesystem).
const fs = require("node:fs");
const run = Number(process.argv[2]);
let sum = 0;
for (let i = 0; i < 1_000_000; i++) sum += i % 7;
const fresh = !fs.existsSync("/tmp/.ran");
fs.writeFileSync("/tmp/.ran", String(run));
console.log(JSON.stringify({ run, sum, fresh, engine: "lifo" }));

# Wave explorer

An Observable Framework notebook, served from a container in this tab.

```js
const frequency = view(Inputs.range([0.5, 8], {value: 2, step: 0.5, label: "Frequency"}));
const amplitude = view(Inputs.range([0.2, 1.5], {value: 1, step: 0.1, label: "Amplitude"}));
```

```js
Plot.plot({
  height: 260,
  y: {domain: [-1.6, 1.6], grid: true},
  marks: [
    Plot.ruleY([0]),
    Plot.line(d3.range(0, 2 * Math.PI, 0.01), {
      x: (t) => t,
      y: (t) => amplitude * Math.sin(frequency * t),
      stroke: "steelblue",
      strokeWidth: 2
    })
  ]
})
```

At *t* = 1 the wave is at **${(amplitude * Math.sin(frequency)).toFixed(3)}**.

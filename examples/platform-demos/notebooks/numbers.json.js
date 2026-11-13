// A data loader: the build bundles it (d3-array from the package store), runs it once in a Worker
// Loader isolate and serves what it returns as numbers.json, beside the notebooks.
import { range } from "d3-array";

export default () => range(1, 11);

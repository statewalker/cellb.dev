// The server part, called with relative URLs: the app runs under the sandbox's path here, and at
// the root of its own origin once deployed.
export interface Task {
  id: number;
  title: string;
  done: boolean;
}

async function call(path: string, init?: RequestInit): Promise<Task[]> {
  const res = await fetch(`api/lists/${path}`, init);
  if (!res.ok)
    throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export const tasks = {
  list: (list: string) => call(`${encodeURIComponent(list)}/tasks`),
  add: (list: string, title: string) =>
    call(`${encodeURIComponent(list)}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  toggle: (list: string, id: number) =>
    call(`${encodeURIComponent(list)}/tasks/${id}/toggle`, { method: "POST" }),
  remove: (list: string, id: number) =>
    call(`${encodeURIComponent(list)}/tasks/${id}`, { method: "DELETE" }),
};

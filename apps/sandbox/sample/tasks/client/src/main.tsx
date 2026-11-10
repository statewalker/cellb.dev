import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Task, tasks } from "./api";

function App() {
  const [list, setList] = useState("today");
  const [items, setItems] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();

  const run = (p: Promise<Task[]>) =>
    p.then(
      (t) => {
        setItems(t);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );

  useEffect(() => {
    tasks.list(list).then(setItems, (e: Error) => setError(e.message));
  }, [list]);

  const left = items.filter((t) => !t.done).length;
  return (
    <main>
      <header>
        <h1>Tasks</h1>
        <label>
          List
          <select value={list} onChange={(e) => setList(e.target.value)}>
            <option value="today">Today</option>
            <option value="later">Later</option>
          </select>
        </label>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void run(tasks.add(list, title));
          setTitle("");
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          aria-label="New task"
        />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul>
        {items.map((t) => (
          <li key={t.id} className={t.done ? "done" : ""}>
            <label>
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => void run(tasks.toggle(list, t.id))}
              />
              {t.title}
            </label>
            <button
              type="button"
              aria-label={`Delete ${t.title}`}
              onClick={() => void run(tasks.remove(list, t.id))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <footer>
        {items.length === 0 ? "No tasks yet." : `${left} of ${items.length} left.`} Each list is a
        Durable Object with its own SQLite database.
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

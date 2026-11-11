import { useState } from "react";
import { newTask, summary, type Task } from "./tasks.ts";

export function App({ title }: { title: string }) {
  const [tasks, setTasks] = useState<Task[]>(() =>
    ["Write the files", "Take a snapshot", "Open the page"].map(newTask),
  );
  const [text, setText] = useState("");
  const toggle = (id: string) =>
    setTasks(tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  return (
    <main className="tasks">
      <h1>{title}</h1>
      <p className="summary">{summary(tasks)}</p>
      <ul>
        {tasks.map((t) => (
          <li key={t.id} className={t.done ? "done" : ""}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} /> {t.text}
            </label>
            <code>{t.id}</code>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) setTasks([...tasks, newTask(text.trim())]);
          setText("");
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="New task" />
        <button type="submit">Add</button>
      </form>
    </main>
  );
}

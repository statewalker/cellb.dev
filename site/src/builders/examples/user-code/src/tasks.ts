import { nanoid } from "nanoid";

export interface Task {
  id: string;
  text: string;
  done: boolean;
}

export const newTask = (text: string): Task => ({ id: nanoid(8), text, done: false });

export const summary = (tasks: Task[]): string => {
  const done = tasks.filter((t) => t.done).length;
  return `${done} of ${tasks.length} done`;
};

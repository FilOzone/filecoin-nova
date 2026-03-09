import { createInterface, Interface } from "node:readline";

let rl: Interface | null = null;

function getRL(): Interface {
  if (!rl) {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return rl;
}

export function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    getRL().question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

export function close(): void {
  if (rl) {
    rl.close();
    rl = null;
  }
}

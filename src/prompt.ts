import { createInterface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';

type Input = Readable & { isTTY?: boolean };

/**
 * Line prompts for the terminal. Secrets are read with echo muted. Lines are buffered, so piped
 * input works as well, which keeps tokens out of process arguments in scripted runs too.
 */
export function createPrompter(
  input: Input = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
) {
  let muted = false;
  const sink = new Writable({
    write(chunk, encoding, done) {
      if (!muted) {
        output.write(chunk, encoding);
      }
      done();
    },
  });
  const terminal = input.isTTY === true;

  /**
   * No history: arrow keys at a later prompt must not bring back a secret. Mute as soon as a line
   * is accepted: anything after it in the same paste, or typed ahead, may be the next answer, and
   * that answer may be a secret.
   */
  function open() {
    const rl = createInterface({ input, output: sink, terminal, historySize: 0 });
    rl.on('line', () => {
      muted = true;
    });

    return { rl, lines: rl[Symbol.asyncIterator]() };
  }
  let { rl, lines } = open();

  /**
   * Prompts are written directly, without readline's redraw, whenever input is already pending:
   * the redraw would show typed-ahead text, which may be the start of a secret. A secret's prompt
   * is always written directly. Piped input closes readline at its end while lines are still
   * buffered, so its prompts are written directly too.
   */
  async function read(question: string, secret: boolean): Promise<string> {
    if (terminal && !secret && rl.line === '') {
      muted = false;
      rl.setPrompt(question);
      rl.prompt();
    } else {
      output.write(question);
    }
    if (secret) {
      muted = true;
    }

    try {
      const line = await lines.next();
      if (line.done) {
        throw new Error('Input ended before an answer was given.');
      }

      if (secret && terminal) {
        // Readline keeps text deleted with Ctrl-U or Ctrl-K for Ctrl-Y to paste back and can't
        // clear it, so a fresh interface follows each secret. Answers pasted after the secret in
        // the same chunk are dropped with the old one.
        rl.close();
        ({ rl, lines } = open());
      }

      return line.value.trim();
    } finally {
      if (secret) {
        output.write('\n');
      }
    }
  }

  return {
    ask: (question: string) => read(question, false),
    askSecret: (question: string) => read(question, true),
    async confirm(question: string, fallback: boolean) {
      const answer = (
        await read(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `, false)
      ).toLowerCase();
      return answer === '' ? fallback : answer === 'y' || answer === 'yes';
    },
    close: () => rl.close(),
  };
}

export type Prompter = ReturnType<typeof createPrompter>;

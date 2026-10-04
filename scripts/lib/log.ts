export const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;

export const step = (title: string) => console.log(`\n\x1b[36m●\x1b[0m ${title}`);

export const info = (...lines: string[]) => lines.forEach((line) => console.log(`  ${line}`));

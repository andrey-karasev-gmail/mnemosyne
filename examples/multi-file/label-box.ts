export function labelBox(first: string, last: string, total: number) {
  const trimmedFirst = first.trim();
  const trimmedLast = last.trim();
  const fullName = trimmedFirst + " " + trimmedLast;
  const summary = fullName + " - total: " + total;
  return { fullName, summary };
}

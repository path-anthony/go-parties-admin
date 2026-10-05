// A cell that starts with = + - @ (or a tab or carriage return) is run as a
// formula by a spreadsheet. Text from customers and staff is exported, so
// such a cell gets a leading apostrophe, which spreadsheets show as nothing
// and treat as "this is text". A plain negative number is left alone.
export function neutralizeCell(value: string): string {
  if (/^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value)) return `'${value}`;
  return value;
}

function escapeCsvField(raw: string): string {
  const value = neutralizeCell(raw);
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvField).join(","));
  return lines.join("\n") + "\n";
}

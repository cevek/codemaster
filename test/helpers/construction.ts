// Shared fixtures + view shapes for the `construction_sites` differential tests, split across
// two files to stay under the 300-line cap. The op's data shape projected for assertions.

export const USER_TYPE = `export interface User { id: number; name: string; }\n`;

export type CSite = {
  span: { file: string; line: number; col: number; text: string };
  confidence: string;
  note?: string;
  encloser: { id: string; name: string; kind: string; exported: boolean; file: string };
};

export type CView = {
  target: { name: string; kind: string; span: { file: string; line: number } };
  sites: CSite[];
  scanned: { literals: number; files: number };
  truncated?: { examined: number; candidates: number };
  notes?: string[];
};

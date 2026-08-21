// utils/docxToPlainText.ts
import mammoth from "mammoth";

/**
 * Convert multiple DOCX files into plain text.
 * @param files - Array of uploaded Word (.docx) files
 * @returns Array of plain text contents, one per file
 */
export async function docxFilesToPlainText(files: File[]): Promise<string[]> {
  const results: string[] = [];

  for (const file of files) {
    const arrayBuffer = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer });

    const plainText = value
      .replace(/\s+/g, " ")     // collapse multiple spaces
    //   .replace(/\n{2,}/g, "\n") // collapse multiple newlines
      .trim();

    results.push(plainText);
  }

  return results;
}
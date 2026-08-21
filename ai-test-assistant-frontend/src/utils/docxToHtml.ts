// utils/docxToHtml.ts
import mammoth from "mammoth";

/**
 * Convert multiple DOCX files into HTML strings.
 * @param files - Array of uploaded Word (.docx) files
 * @returns Array of HTML strings
 */
export async function docxFilesToHtml(files: File[]): Promise<string[]> {
  const results: string[] = [];

  for (const file of files) {
    const arrayBuffer = await file.arrayBuffer();
    const { value } = await mammoth.convertToHtml({ arrayBuffer });

     // Add file name and separator line before content
    const htmlContent = `
      <h3>${file.name}</h3>
      <hr />
      ${value.trim()}
    `;
    results.push("<h3 style=\"font-weight:bold;\">" + file.name + "</h3> <hr/> " + value.trim());
}

  return results;
}
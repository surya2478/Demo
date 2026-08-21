export function getTimestampedFilename(base = "test-cases") {
    const now = new Date();
    const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const time = now.toTimeString().slice(0, 5).replace(":", "-"); // HH-MM
    return `${base}_${date}_${time}.xlsx`;
  }
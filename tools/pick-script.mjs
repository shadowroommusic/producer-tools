/**
 * Build the one AppleScript invocation behind /api/agent/pick.
 *
 * Kept separate from the HTTP server so the folder/file branches can be tested without opening a
 * native dialog or starting another bridge process. Prompts are fixed here; request data never gets
 * interpolated into AppleScript.
 */
export function buildPickScript(body) {
  const folderMode = body?.kind === "folder";
  const multiple = !folderMode && body?.multiple === true;
  const prompt = folderMode ? "选择音乐文件夹" : multiple ? "选择音频文件（可多选）" : "选择音频文件";
  const script = folderMode
    ? [
        `set theFolder to choose folder with prompt "${prompt}"`,
        "return POSIX path of theFolder",
      ].join("\n")
    : [
        `set theFiles to choose file with prompt "${prompt}" of type {"public.audio", "public.midi-audio"}${multiple ? " with multiple selections allowed" : ""}`,
        "if class of theFiles is not list then set theFiles to {theFiles}",
        "set thePaths to {}",
        "repeat with theFile in theFiles",
        "set end of thePaths to POSIX path of theFile",
        "end repeat",
        "set AppleScript's text item delimiters to linefeed",
        "return thePaths as text",
      ].join("\n");
  return { folderMode, multiple, script };
}

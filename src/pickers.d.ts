// The File System Access API's pickers, which Chromium on a computer has and
// TypeScript's DOM library does not; elsewhere they are missing, as typed.

interface SaveFilePickerOptions {
  suggestedName?: string;
  id?: string;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
}

interface Window {
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}

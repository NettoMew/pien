// What Chromium on a computer has of the File System Access API, and
// TypeScript's DOM library does not: the pickers, asking a handle what it
// may do, and moving one. Elsewhere they are missing, as typed.

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

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  move?(parent: FileSystemDirectoryHandle, name: string): Promise<void>;
}

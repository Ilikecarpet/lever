/** The OS Lever is running on. WebView2's user agent names Windows; WKWebView's
 *  names the Mac. Read once: it cannot change while the app runs. */
export const isWindows = navigator.userAgent.includes("Windows");

/** Where saved database passwords live on this OS. */
export const secretStore = isWindows ? "Windows Credential Manager" : "Keychain";

/** Monospace stacks for terminals: each OS's own first, then the shared ones. */
export const terminalFont = '"SF Mono", "Cascadia Mono", Consolas, "JetBrains Mono", "Fira Code", monospace';

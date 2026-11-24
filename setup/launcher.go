// Nestrill Windows launcher. Copyright (c) 2026 Munus Modulus, MIT License.
// Runs only the control script belonging to the current installation.
package main

import (
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "strings"
    "syscall"
    "unicode/utf16"
    "unicode/utf8"
    "unsafe"
)
func message(title, body string, errorIcon bool) {
    dll := syscall.NewLazyDLL("user32.dll")
    proc := dll.NewProc("MessageBoxW")
    t, _ := syscall.UTF16PtrFromString(title)
    b, _ := syscall.UTF16PtrFromString(body)
    var flags uintptr = 0x40 // MB_ICONINFORMATION
    if errorIcon { flags = 0x10 } // MB_ICONERROR
    proc.Call(0, uintptr(unsafe.Pointer(b)), uintptr(unsafe.Pointer(t)), flags)
}
// Windows PowerShell 5.1 writes console/pipe output using the Windows console
// code page, which on Japanese Windows is frequently CP932 rather than UTF-8.
// Converting those raw bytes directly to a Go string produces broken Japanese.
// Prefer valid UTF-8, otherwise decode using the active OEM console code page.
// Do not add any external Go dependencies to the portable application.
func decodePowerShellOutput(output []byte) string {
    if len(output) == 0 { return "" }
    if utf8.Valid(output) { return strings.TrimSpace(string(output)) }
    kernel := syscall.NewLazyDLL("kernel32.dll")
    getCP := kernel.NewProc("GetOEMCP")
    cp, _, _ := getCP.Call()
    if cp == 0 { cp = 932 } // Last resort for the Japanese locale.
    convert := kernel.NewProc("MultiByteToWideChar")
    n, _, _ := convert.Call(cp, 0,
        uintptr(unsafe.Pointer(&output[0])), uintptr(len(output)), 0, 0)
    if n == 0 { return "（PowerShellの出力を読み取れませんでした）" }
    wide := make([]uint16, int(n))
    got, _, _ := convert.Call(cp, 0,
        uintptr(unsafe.Pointer(&output[0])), uintptr(len(output)),
        uintptr(unsafe.Pointer(&wide[0])), n)
    if got == 0 { return "（PowerShellの出力を読み取れませんでした）" }
    return strings.TrimSpace(string(utf16.Decode(wide[:int(got)])))
}
func main() {
    exe, err := os.Executable()
    if err != nil { message("Nestrill", fmt.Sprintf("起動元を確認できません: %v", err), true); return }
    root := filepath.Dir(exe)
    script := filepath.Join(root, "scripts", "Nestrill-Control.ps1")
    if _, err := os.Stat(script); err != nil {
        message("Nestrill", "必要なファイルが見つかりません。インストール先を確認してください。\n"+script, true)
        return
    }
    action := "Start"
    if len(os.Args) > 1 {
        if len(os.Args) != 2 { message("Nestrill", "使用できない起動オプションです。", true); return }
        switch os.Args[1] {
        case "--stop": action = "Stop"
        case "--status": action = "Status"
        default: message("Nestrill", "使用できない起動オプションです。", true); return
        }
    }
    shell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if _, err := os.Stat(shell); err != nil { shell = "powershell.exe" }
    cmd := exec.Command(shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action)
    cmd.Dir = root
    cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
    output, err := cmd.CombinedOutput()
    if err != nil {
        detail := decodePowerShellOutput(output)
        if len([]rune(detail)) > 1100 {
            runes := []rune(detail)
            detail = string(runes[len(runes)-1100:])
        }
        if detail == "" { detail = err.Error() }
        title := "Nestrillの操作に失敗しました"
        hint := "詳細はインストール先の Start-Nestrill.cmd から確認できます。"
        if action == "Stop" {
            title = "Nestrillを終了できませんでした"
            hint = "詳細はインストール先の Stop-Nestrill.cmd から確認できます。"
        }
        message(title, detail+"\n\n"+hint, true)
        return
    }
    // Stop is silent on success, including the already-stopped case.
    // An "operation complete" popup is not useful for an everyday Stop menu.
    if action == "Stop" || action == "Start" { return }
    if action == "Status" {
        detail := decodePowerShellOutput(output)
        if detail == "" { detail = "状態を取得しました。" }
        message("Nestrill", detail, false)
    }
}

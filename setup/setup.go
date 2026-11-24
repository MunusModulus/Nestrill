// Nestrill Windows setup launcher. Copyright (c) 2026 Munus Modulus, MIT License.
// Actual installation is performed by the bundled PowerShell script.
package main
import (
    _ "embed"
    "fmt"
    "os"
    "os/exec"
    "path/filepath"
    "syscall"
    "unsafe"
)
//go:embed payload.zip
var payload []byte
//go:embed installer.ps1
var installer []byte
func showError(message string) {
    dll := syscall.NewLazyDLL("user32.dll")
    proc := dll.NewProc("MessageBoxW")
    title, _ := syscall.UTF16PtrFromString("Nestrill セットアップ")
    body, _ := syscall.UTF16PtrFromString(message)
    proc.Call(0, uintptr(unsafe.Pointer(body)), uintptr(unsafe.Pointer(title)), 0x10)
}
func run() error {
    stage, err := os.MkdirTemp("", "Nestrill-Setup-")
    if err != nil { return err }
    defer os.RemoveAll(stage)
    archive := filepath.Join(stage,"Nestrill-payload.zip")
    script := filepath.Join(stage,"Nestrill-Installer.ps1")
    if err := os.WriteFile(archive, payload, 0600); err != nil { return err }
    if err := os.WriteFile(script, installer, 0600); err != nil { return err }
    args := []string{"-NoProfile","-STA","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File",script,"-Mode","Install","-PayloadPath",archive}
    cmd := exec.Command("powershell.exe",args...)
    cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow:true}
    if err := cmd.Run(); err != nil { return fmt.Errorf("Windows PowerShellでのセットアップを完了できませんでした。\n%s",err) }
    return nil
}
func main() { if err := run(); err != nil { showError(err.Error()) } }

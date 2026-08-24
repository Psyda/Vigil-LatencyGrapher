; Vigil NSIS additions, included by electron-builder's assisted installer.
;
; Adds a "start when you sign in" page with the box checked by default,
; since background monitoring from login is how the app is meant to run.
; The registry entry name and command line exactly match what Electron's
; app.setLoginItemSettings writes, so the in-app settings checkbox reflects
; and can change whatever the installer set up.
;
; The page functions live inside customPageAfterChangeDir because this file
; is included before MUI2, and MUI_HEADER_TEXT only exists once the macro is
; expanded in the pages region of the generated script.

!include nsDialogs.nsh
!include LogicLib.nsh

; Only the installer pass uses these. The uninstaller compiles this file too,
; and an unreferenced Var there is a warning that electron-builder treats as
; an error.
!ifndef BUILD_UNINSTALLER
  Var vigilAutostartCheckbox
  Var vigilAutostartState
!endif

!macro customPageAfterChangeDir
  Page custom vigilAutostartPage vigilAutostartPageLeave

  Function vigilAutostartPage
    !insertmacro MUI_HEADER_TEXT "Startup" "Vigil monitors best when it is always running"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 24u "Vigil builds its history by probing continuously in the background. Starting it at sign-in keeps the record unbroken, and it opens quietly to the tray."
    Pop $0
    ${NSD_CreateCheckbox} 0 32u 100% 12u "Start Vigil when I sign in to Windows (recommended)"
    Pop $vigilAutostartCheckbox
    ${NSD_Check} $vigilAutostartCheckbox
    nsDialogs::Show
  FunctionEnd

  Function vigilAutostartPageLeave
    ${NSD_GetState} $vigilAutostartCheckbox $vigilAutostartState
  FunctionEnd
!macroend

!macro customInstall
  ; Unset state (e.g. a silent /S install skips the page) counts as checked,
  ; matching the recommended default.
  ${If} $vigilAutostartState == ${BST_UNCHECKED}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Vigil"
  ${Else}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Vigil" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
  ${EndIf}
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Vigil"
!macroend

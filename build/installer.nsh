!macro customInstall
  ; This hook runs after files and shortcuts are installed. The updater
  ; launches the installer without --force-run so this is the sole restart.
  ${If} ${isUpdated}
  ${AndIf} ${Silent}
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "--updated"
    ${If} $0 != "ok"
    ${AndIf} $0 != "fallback"
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
!macroend

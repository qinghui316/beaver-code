!macro customInstall
  ; This hook runs after files and shortcuts are installed. The updater
  ; launches the installer without --force-run so this is the sole restart.
  ${If} ${isUpdated}
  ${AndIf} ${Silent}
    ClearErrors
    ExecShell "open" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--updated" SW_SHOWNORMAL
    IfErrors beaver_relaunch_failed beaver_relaunch_done
    beaver_relaunch_failed:
      SetErrorLevel 1
      Quit
    beaver_relaunch_done:
  ${EndIf}
!macroend

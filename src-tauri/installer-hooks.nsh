; An update keeps existing shortcuts, and with them the AppUserModelID that
; Windows shows notifications under. Give them this build's identifier, which
; changed in 1.0, as a fresh install does.
!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}
!macroend

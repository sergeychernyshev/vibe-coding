tell application "OBS"
    activate
end tell
delay 1
tell application "System Events"
  tell process "OBS"
    if exists window 1 then
      set size of window 1 to {1146, 1440}
      set position of window 1 to {0, 0}
    else
      display dialog "OBS main window not found."
    end if
  end tell
end tell

tell application "Terminal"
  activate
end tell
delay 1
tell application "System Events"
  tell process "Terminal"
    if exists window 1 then
      set size of window 1 to {1146, 850}
      set position of window 1 to {1147, 0}
    else
      display dialog "Terminal main window not found."
    end if
  end tell
end tell

tell application "Google Chrome Canary"
  activate
  open location "https://dashboard.twitch.tv/u/sergeychernyshev/stream-manager"
end tell
delay 1
tell application "System Events"
  tell process "Google Chrome Canary"
    if exists window 1 then
      set size of window 1 to {1146, 1440}
      set position of window 1 to {2294, 0}
    else
      display dialog "Google Chrome Canary main window not found."
    end if
  end tell
end tell

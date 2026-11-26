#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <shellapi.h>

static void to_url(char *s) { for (; *s; s++) if (*s == '\\') *s = '/'; }

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrev, LPSTR lpCmd, int nShow) {
  (void)hInst; (void)hPrev; (void)lpCmd; (void)nShow;

  char dir[MAX_PATH];
  if (!GetModuleFileNameA(NULL, dir, MAX_PATH)) return 1;
  char *slash = strrchr(dir, '\\');
  if (slash) *slash = '\0';

  char page[MAX_PATH + 32];
  snprintf(page, sizeof page, "%s/index.html", dir);
  if (GetFileAttributesA(page) == INVALID_FILE_ATTRIBUTES) {
    MessageBoxA(NULL,
                "index.html is missing.\n\nUnzip the whole folder first, then run Aria.exe from inside it.",
                "Aria", MB_ICONERROR | MB_OK);
    return 1;
  }

  /* Edge ships with Windows 10 and 11; Chrome is used if Edge is missing. */
  const char *tries[] = {
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  };
  char browser[MAX_PATH] = {0};
  for (int i = 0; i < 4; i++) {
    if (GetFileAttributesA(tries[i]) != INVALID_FILE_ATTRIBUTES) { strcpy(browser, tries[i]); break; }
  }

  if (browser[0]) {
    char url[MAX_PATH * 3];
    strcpy(url, page);
    to_url(url);
    char cmdline[MAX_PATH * 4];
    snprintf(cmdline, sizeof cmdline,
             "\"%s\" --app=\"file:///%s\" --window-size=1040,820 --user-data-dir=\"%s/profile\"",
             browser, url, dir);
    STARTUPINFOA si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof si); si.cb = sizeof si;
    ZeroMemory(&pi, sizeof pi);
    if (CreateProcessA(NULL, cmdline, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
      CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
      return 0;
    }
  }

  /* No Edge or Chrome: let Windows open it in whatever browser it has. */
  ShellExecuteA(NULL, "open", page, NULL, dir, SW_SHOWNORMAL);
  return 0;
}

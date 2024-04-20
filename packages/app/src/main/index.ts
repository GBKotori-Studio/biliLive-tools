import path, { join } from "node:path";
import fs from "fs-extra";
import semver from "semver";
import Store from "electron-store";

import { handlers as biliHandlers, commentQueue } from "./bili";
import log from "./utils/log";
import { trashItem as _trashItem, __dirname } from "./utils/index";
import serverApp from "./server/index";
import { app, dialog, BrowserWindow, ipcMain, shell, Tray, Menu, net } from "electron";
import installExtension from "electron-devtools-installer";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import {
  convertVideo2Mp4,
  mergeAssMp4,
  getAvailableEncoders,
  setFfmpegPath,
  mergeVideos,
  handleReadVideoMeta,
} from "./video";
import { handlers as taskHandlers, taskQueue } from "./task";
import { handlers as biliupHandlers } from "./biliup";
import { handlers as ffmpegHandlers } from "./ffmpegPreset";
import { handlers as danmuHandlers } from "./danmu";
import { configHandlers } from "./handlers";
import { handlers as notidyHandlers } from "./notify";
import icon from "../../resources/icon.png?asset";
import { appConfig } from "biliLive-tools@shared";
import { FFMPEG_PATH, FFPROBE_PATH } from "./appConstant";

import type { OpenDialogOptions } from "../types";
import type { IpcMainInvokeEvent, IpcMain, SaveDialogOptions } from "electron";

const WindowState = new Store({
  name: "window-state",
});
const windowConfig = {
  width: 900,
  height: 750,
  isMaximized: false,
};

const registerHandlers = (
  ipcMain: IpcMain,
  handlers: {
    [key: string]: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any;
  },
) => {
  Object.keys(handlers).forEach((key) => {
    ipcMain.handle(key, handlers[key]);
  });
};

const genHandler = (ipcMain: IpcMain) => {
  // 通用函数
  ipcMain.handle("dialog:openDirectory", openDirectory);
  ipcMain.handle("dialog:openFile", openFile);
  ipcMain.handle("dialog:save", saveDialog);
  ipcMain.handle("getVersion", getVersion);
  ipcMain.handle("openExternal", openExternal);
  ipcMain.handle("openPath", openPath);
  ipcMain.handle("exits", exits);
  ipcMain.handle("trashItem", trashItem);
  ipcMain.handle("common:relaunch", relaunch);
  ipcMain.handle("common:setOpenAtLogin", setOpenAtLogin);
  ipcMain.handle("common:showItemInFolder", showItemInFolder);

  // 视频处理
  ipcMain.handle("convertVideo2Mp4", convertVideo2Mp4);
  ipcMain.handle("mergeAssMp4", mergeAssMp4);
  ipcMain.handle("getAvailableEncoders", getAvailableEncoders);
  ipcMain.handle("readVideoMeta", handleReadVideoMeta);
  ipcMain.handle("mergeVideos", mergeVideos);

  registerHandlers(ipcMain, biliupHandlers);
  registerHandlers(ipcMain, biliHandlers);
  registerHandlers(ipcMain, taskHandlers);
  registerHandlers(ipcMain, ffmpegHandlers);
  registerHandlers(ipcMain, danmuHandlers);
  registerHandlers(ipcMain, configHandlers);
  registerHandlers(ipcMain, notidyHandlers);
};

let server: any;
export let mainWin: BrowserWindow;
function createWindow(): void {
  Object.assign(windowConfig, WindowState.get("winBounds"));

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    ...windowConfig,
    show: false,
    autoHideMenuBar: false,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      webSecurity: false,
    },
  });
  if (windowConfig.isMaximized) {
    mainWindow.maximize();
  }
  mainWindow.on("close", () => {
    Object.assign(
      windowConfig,
      {
        isMaximized: mainWindow.isMaximized(),
      },
      mainWindow.getNormalBounds(),
    );
    WindowState.set("winBounds", windowConfig); // saves window's properties using electron-store
  });

  mainWindow.on("ready-to-show", () => {
    if (is.dev) {
      // mainWindow.webContents.openDevTools();
      mainWindow.showInactive();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
  mainWin = mainWindow;
  const content = mainWindow.webContents;

  content.on("render-process-gone", (_event, details) => {
    log.error(`render-process-gone: ${JSON.stringify(details)}`);
  });
  content.on("unresponsive", (event) => {
    log.error(`unresponsive: ${JSON.stringify(event)}`);
  });
  content.on("preload-error", (_event, preloadPath, error) => {
    log.error(`preload-error: ${preloadPath},${error}`);
  });

  // 触发关闭时触发
  mainWin.on("close", (event) => {
    const closeToTray = appConfig.get("closeToTray");
    if (closeToTray) {
      event.preventDefault();
      mainWin.hide();
      mainWin.setSkipTaskbar(true);
    }
  });
  // 窗口最小化
  mainWin.on("minimize", (event) => {
    const minimizeToTray = appConfig.get("minimizeToTray");
    if (minimizeToTray) {
      event.preventDefault();
      mainWin.hide();
      mainWin.setSkipTaskbar(true);
    }
  });

  // 新建托盘
  const tray = new Tray(join(icon));
  // 托盘名称
  tray.setToolTip("biliLive-tools");
  // 托盘菜单
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "打开log文件夹",
      click: () => {
        shell.openPath(app.getPath("logs"));
      },
    },
    {
      label: "显示",
      click: () => {
        mainWin.show();
      },
    },
    {
      label: "退出",
      click: async () => {
        quit();
      },
    },
  ]);
  // 载入托盘菜单
  tray.setContextMenu(contextMenu);
  // 双击触发
  tray.on("double-click", () => {
    mainWin.isVisible() ? mainWin.hide() : mainWin.show();
    mainWin.isVisible() ? mainWin.setSkipTaskbar(false) : mainWin.setSkipTaskbar(true);
  });
}

function createMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "设置",
      click: () => {
        mainWin.show();
        mainWin.webContents.send("open-setting");
      },
    },
    {
      label: "打开log文件夹",
      click: () => {
        shell.openPath(app.getPath("logs"));
      },
    },
    {
      label: "检测更新",
      click: async () => {
        try {
          const status = await checkUpdate();
          if (status) {
            dialog.showMessageBox(mainWin, {
              message: "当前已经是最新版本",
              buttons: ["确认"],
            });
          }
        } catch (error) {
          log.error(error);
          const confirm = await dialog.showMessageBox(mainWin, {
            message: "检查更新失败，请前往仓库查看",
            buttons: ["取消", "确认"],
          });
          if (confirm.response === 1) {
            shell.openExternal("https://github.com/renmu123/biliLive-tools/releases");
          }
        }
      },
    },
    {
      label: "开发者工具",
      role: "viewMenu",
    },
    {
      label: "赞助",
      click: async () => {
        shell.openExternal("https://afdian.net/a/renmu123");
      },
    },
    {
      label: "退出",
      click: async () => {
        quit();
      },
    },
  ]);
  Menu.setApplicationMenu(menu);
}

const canQuit = async () => {
  const tasks = taskQueue.list();
  const isRunning = tasks.some((task) => ["running", "paused", "pending"].includes(task.status));
  if (isRunning) {
    const confirm = await dialog.showMessageBox(mainWin, {
      message: "检测到有未完成的任务，是否退出？",
      buttons: ["取消", "退出"],
    });
    if (confirm.response === 1) {
      return true;
    } else {
      return false;
    }
  }
  return true;
};

// 退出应用时检测任务
const quit = async () => {
  try {
    Object.assign(
      windowConfig,
      {
        isMaximized: mainWin.isMaximized(),
      },
      mainWin.getNormalBounds(),
    );
    WindowState.set("winBounds", windowConfig); // saves window's properties using electron-store

    const canQuited = await canQuit();
    if (canQuited) {
      mainWin.destroy();
      app.quit();
    }
  } catch (e) {
    mainWin.destroy();
    log.error(e);
  }
};

export const relaunch = async () => {
  const canQuited = await canQuit();
  if (canQuited) {
    app.relaunch();
    app.exit(0);
  }
};

export const setOpenAtLogin = (_event: IpcMainInvokeEvent, openAtLogin: boolean) => {
  app.setLoginItemSettings({
    openAtLogin,
  });
};

const showItemInFolder = async (_event: IpcMainInvokeEvent, path: string) => {
  shell.showItemInFolder(path);
};

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    electronApp.setAppUserModelId("com.electron");
    installExtension("nhdogjmejiglipccpnnnanhbledajbpd")
      .then((name) => log.debug(`Added Extension:  ${name}`))
      .catch((err) => log.debug("An error occurred: ", err));

    log.info(`app start, version: ${app.getVersion()}`);
    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    createWindow();
    createMenu();
    genHandler(ipcMain);
    appInit();

    // mainWin.on("closed", () => {
    //   console
    //   // mainWin = null;
    // });

    app.on("activate", function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  process.on("uncaughtException", function (error) {
    log.error("uncaughtException", error);
    log.error(error);
  });
  process.on("unhandledRejection", function (error) {
    log.error("unhandledRejection", error);
    // event.sender.send("notify", data);
    mainWin.webContents.send("notify", {
      type: "error",
      content: String(error),
    });
  });

  app.on("second-instance", () => {
    // 有人试图运行第二个实例，我们应该关注我们的窗口
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      if (!mainWin.isVisible()) mainWin.show();
      mainWin.focus();
    }
  });

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on("window-all-closed", () => {
    log.info("app quit");
    if (process.platform !== "darwin") {
      app.quit();
    }
    server.close(() => {
      console.log("Express app is now closed");
    });
  });
}

// 业务相关的初始化
const appInit = async () => {
  appConfig.init(path.join(app.getPath("userData"), "appConfig.json"), {
    ffmpegPath: FFMPEG_PATH,
    ffprobePath: FFPROBE_PATH,
    tool: {
      download: {
        savePath: app.getPath("downloads"),
      },
    },
  });

  setFfmpegPath();
  // 默认十分钟运行一次
  commentQueue.run(1000 * 60 * 10);
  const webhook = appConfig.get("webhook");
  log.transports.file.level = appConfig.get("logLevel");

  if (webhook?.open) {
    // 新建监听
    server = serverApp.listen(webhook.port, () => {
      log.info("server start");
    });
  }

  // 检测更新
  if (appConfig.get("autoUpdate")) {
    checkUpdate();
  }
};

const openDirectory = async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    properties: ["openDirectory"],
  });
  if (canceled) {
    return;
  } else {
    return filePaths[0];
  }
};
const openFile = async (_event: IpcMainInvokeEvent, options: OpenDialogOptions) => {
  const properties: ("openFile" | "multiSelections")[] = ["openFile"];
  if (options.multi) {
    properties.push("multiSelections");
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
    properties,
    ...options,
  });
  if (canceled) {
    return;
  } else {
    return filePaths;
  }
};

const saveDialog = async (_event: IpcMainInvokeEvent, options: SaveDialogOptions) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, options);
  if (canceled) {
    return;
  } else {
    return filePath;
  }
};

const getVersion = () => {
  return app.getVersion();
};

const openExternal = (_event: IpcMainInvokeEvent, url: string) => {
  shell.openExternal(url);
};

const openPath = (_event: IpcMainInvokeEvent, path: string) => {
  shell.openPath(path);
};

const exits = (_event: IpcMainInvokeEvent, path: string) => {
  return fs.pathExists(path);
};

const trashItem = async (_event: IpcMainInvokeEvent, path: string) => {
  return await _trashItem(path);
};

const checkUpdate = async () => {
  await app.whenReady();
  const res = await net.fetch(
    "https://githubraw.irenmu.com/renmu123/biliLive-tools/master/package.json",
  );
  const data = await res.json();
  const latestVersion = data.version;
  const version = app.getVersion();

  if (semver.gt(latestVersion, version)) {
    const confirm = await dialog.showMessageBox(mainWin, {
      message: "检测到有新版本，是否前往下载？",
      buttons: ["取消", "确认"],
    });
    if (confirm.response === 1) {
      shell.openExternal("https://github.com/renmu123/biliLive-tools/releases");
    }
    return false;
  }
  return true;
};

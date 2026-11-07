/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VTA_CREDENTIAL?: string;
  readonly VTC_DID?: string;
}
declare const __COLLAB_MODE__: "mock" | "live";
declare const __COLLAB_ROOM__: string;
declare const __FARM__: boolean;
declare const __VTA_BROWSER_URL__: string;
declare const __VTA_URL__: string;
declare const __VTC_BROWSER_URL__: string;
declare const __VTC_URL__: string;

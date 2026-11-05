const FIELDS = [
  ["urls", "backend", "BACKEND_URL", "string"],
  ["urls", "ai", "AI_API_URL", "string"],
  ["authentication", "allowEmailLogin", "AUTHENTICATION_ALLOW_EMAIL_LOGIN", "bool"],
  ["authentication", "identityProviders", "AUTHENTICATION_IDENTITY_PROVIDERS", "list"],
  ["authentication", "sendUserEmailAsHeader", "AUTHENTICATION_SEND_USER_EMAIL_AS_HEADER", "bool"],
  ["authProviders", "googleClientId", "GOOGLE_OAUTH_CLIENT_ID", "string"],
  ["copilot", "enabled", "AI_COPILOT_ENABLED", "bool"],
  ["copilot", "defaultCopilot", "AI_COPILOT_DEFAULT_COPILOT", "bool"],
  ["copilot", "documentationLinks", "AI_COPILOT_DOCUMENTATION_LINKS", "bool"],
  ["copilot", "aiEnhancements", "AI_COPILOT_AI_ENHANCEMENTS", "bool"],
  ["copilot", "saveSkillFromChat", "AI_COPILOT_SAVE_SKILL_FROM_CHAT", "bool"],
  ["copilot", "showCustomKey", "AI_SHOW_CUSTOM_COPILOT_KEY", "bool"],
  ["ui", "showCompanionMode", "UI_SHOW_COMPANION_MCP_MODE", "bool"],
  ["ui", "showMinimizeWidget", "UI_SHOW_MINIMIZE_WIDGET", "bool"],
  ["ui", "showExternalDocLinks", "UI_SHOW_EXTERNAL_DOCUMENTATION_LINKS", "bool"],
  ["ui", "showHelpDocumentation", "UI_SHOW_HELP_DOCUMENTATION", "bool"],
  ["ui", "showChangelog", "UI_SHOW_CHANGELOG", "bool"],
  ["ui", "showCopilotSwitcher", "UI_SHOW_COPILOT_SWITCHER", "bool"],
  ["ui", "showRemoveFromOrg", "UI_SHOW_REMOVE_FROM_ORG", "bool"],
  ["ui", "defaultTheme", "UI_DEFAULT_THEME", "theme"],
  ["data", "allowHtmlJsExecution", "ALLOW_HTML_JS_EXECUTION", "bool"],
  ["links", "docsUrl", "DOCS_URL", "string"],
  ["contact", "supportEmail", "SUPPORT_EMAIL", "string"],
  ["whiteLabel", "name", "WL_NAME", "string"],
  ["whiteLabel", "loginImage", "WL_LOGIN_IMAGE", "string"],
  ["whiteLabel", "leftSidebarLogo", "WL_LEFT_SIDEBAR_LOGO", "string"],
  ["whiteLabel", "leftSidebarLogoDark", "WL_LEFT_SIDEBAR_LOGO_DARK", "string"],
  ["whiteLabel", "favicon", "WL_FAVICON", "string"],
  ["whiteLabel", "description", "WL_DESCRIPTION", "string"],
  ["whiteLabel", "keywords", "WL_KEYWORDS", "string"],
  ["whiteLabel", "stylesheet", "WL_STYLESHEET", "string"],
];

function valueOf(variable, type, raw) {
  if (type === "string") {
    return raw;
  }
  if (type === "list") {
    return raw
      .split(",")
      .map(function (item) {
        return item.toLowerCase().trim();
      })
      .filter(function (item) {
        return item !== "";
      });
  }
  if (type === "bool") {
    if (raw === "true" || raw === "false") {
      return raw === "true";
    }
    throw new Error(variable + " must be true or false");
  }
  if (type === "theme") {
    if (raw === "light" || raw === "dark") {
      return raw;
    }
    throw new Error(variable + " must be light or dark");
  }
  throw new Error("unknown type " + type + " for " + variable);
}

const PLUGIN_SHELL_HASH = "'sha256-SwQ+ybsi2+FldUwGr9q2n39PxMGAMlGhGuKJ5K4cSdY='";
const GOOGLE_SIGN_IN = "https://accounts.google.com/gsi/";
const LOCAL_FRAMES = ["http://localhost:*", "http://127.0.0.1:*", "http://0.0.0.0:*"];
const DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
  "frame-src",
  "worker-src",
  "media-src",
  "manifest-src",
  "object-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
];
const EXTRA_SOURCE =
  /^('(self|unsafe-inline|unsafe-eval|wasm-unsafe-eval)'|'sha(256|384|512)-[A-Za-z0-9+/]+=*'|[a-z][a-z0-9+.-]*:|([a-z][a-z0-9+.-]*:\/\/)?(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(:([0-9]+|\*))?(\/[A-Za-z0-9._~!$&()*+=:@%/-]*)?)$/;

const HEADER_FIELDS = [
  [
    "CSP_EXTRA_SOURCES",
    "Sources to add to the Content-Security-Policy, written like the policy itself: directives separated by semicolons, each followed by its sources, for example img-src https://cdn.example.com; frame-ancestors https://portal.example.com.",
  ],
  [
    "CSP_REPORT_ONLY",
    "true sends the policy as Content-Security-Policy-Report-Only, so the browser reports what it would block without blocking it. Must be true or false.",
  ],
];

function originOf(url) {
  const match = /^(https?):\/\/([^/?#\s]+)/i.exec(url || "");
  return match ? match[1].toLowerCase() + "://" + match[2].toLowerCase() : null;
}

function extraSources(raw) {
  const extra = {};
  const parts = (raw || "").split(";");
  for (let i = 0; i < parts.length; i++) {
    const words = parts[i].trim().split(/\s+/).filter(function (word) {
      return word !== "";
    });
    if (words.length === 0) {
      continue;
    }
    const directive = words[0].toLowerCase();
    if (DIRECTIVES.indexOf(directive) === -1) {
      throw new Error("CSP_EXTRA_SOURCES names " + directive + ", which is not a directive the policy sets");
    }
    for (let j = 1; j < words.length; j++) {
      if (!EXTRA_SOURCE.test(words[j])) {
        throw new Error("CSP_EXTRA_SOURCES has " + words[j] + ", which is not a source expression");
      }
    }
    extra[directive] = (extra[directive] || []).concat(words.slice(1));
  }
  return extra;
}

function policy(env) {
  if (env.CSP_REPORT_ONLY !== undefined && env.CSP_REPORT_ONLY !== "true" && env.CSP_REPORT_ONLY !== "false") {
    throw new Error("CSP_REPORT_ONLY must be true or false");
  }
  const backend = originOf(env.BACKEND_URL);
  const ai = originOf(env.AI_API_URL);
  const google =
    (env.AUTHENTICATION_IDENTITY_PROVIDERS || "")
      .split(",")
      .map(function (item) {
        return item.toLowerCase().trim();
      })
      .indexOf("google") !== -1;
  const htmlScripts = env.ALLOW_HTML_JS_EXECUTION === "true";
  const images = [env.WL_LOGIN_IMAGE, env.WL_LEFT_SIDEBAR_LOGO, env.WL_LEFT_SIDEBAR_LOGO_DARK, env.WL_FAVICON].map(originOf);
  const sources = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", "blob:"]
      .concat(htmlScripts ? ["'unsafe-inline'", "https:"] : [PLUGIN_SHELL_HASH])
      .concat(google ? [GOOGLE_SIGN_IN + "client"] : []),
    "style-src": ["'self'", "'unsafe-inline'", originOf(env.WL_STYLESHEET)].concat(google ? [GOOGLE_SIGN_IN] : []),
    "img-src": ["'self'", "data:", "blob:", "https:", backend].concat(images),
    "font-src": ["'self'", "data:", "https:"],
    "connect-src": ["'self'", "blob:", "data:", "https:", "wss:", backend, backend && backend.replace(/^http/, "ws"), ai].concat(
      google ? [GOOGLE_SIGN_IN] : [],
    ),
    "frame-src": ["'self'", "blob:", "data:", "https:", backend].concat(LOCAL_FRAMES).concat(google ? [GOOGLE_SIGN_IN] : []),
    "worker-src": ["'self'", "blob:"],
    "media-src": ["'self'", "data:", "blob:", "https:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'", "https:"],
    "frame-ancestors": ["'self'"],
  };
  const extra = extraSources(env.CSP_EXTRA_SOURCES);
  return DIRECTIVES.map(function (directive) {
    const seen = [];
    const list = sources[directive].concat(extra[directive] || []);
    for (let i = 0; i < list.length; i++) {
      if (list[i] && seen.indexOf(list[i]) === -1) {
        seen.push(list[i]);
      }
    }
    return directive + " " + seen.join(" ");
  }).join("; ");
}

function headers(env) {
  try {
    const value = policy(env);
    return env.CSP_REPORT_ONLY === "true" ? { enforce: "", reportOnly: value } : { enforce: value, reportOnly: "" };
  } catch (error) {
    return { enforce: "default-src 'none'", reportOnly: "", error: error.message };
  }
}

function contentSecurityPolicy(r) {
  const result = headers(process.env);
  if (result.error) {
    r.error(result.error);
  }
  return result.enforce;
}

function contentSecurityPolicyReportOnly() {
  return headers(process.env).reportOnly;
}

function render(env) {
  const config = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const group = FIELDS[i][0];
    const field = FIELDS[i][1];
    const variable = FIELDS[i][2];
    if (!config[group]) {
      config[group] = {};
    }
    if (env[variable] !== undefined) {
      config[group][field] = valueOf(variable, FIELDS[i][3], env[variable]);
    }
  }
  return "window.__APP_CONFIG__ = " + JSON.stringify(config, null, 2) + ";\n";
}

function configJs(r) {
  let body;
  try {
    body = render(process.env);
  } catch (error) {
    r.error(error.message);
    r.return(500, "");
    return;
  }
  r.return(200, body);
}

function healthz(r) {
  try {
    render(process.env);
    policy(process.env);
  } catch (error) {
    r.error(error.message);
    r.return(500, JSON.stringify({ status: "error", error: error.message }));
    return;
  }
  r.return(200, '{"status": "ok"}');
}

export default {
  FIELDS: FIELDS,
  HEADER_FIELDS: HEADER_FIELDS,
  PLUGIN_SHELL_HASH: PLUGIN_SHELL_HASH,
  render: render,
  policy: policy,
  headers: headers,
  configJs: configJs,
  healthz: healthz,
  contentSecurityPolicy: contentSecurityPolicy,
  contentSecurityPolicyReportOnly: contentSecurityPolicyReportOnly,
};

import Link from "@docusaurus/Link";
import styles from "./styles.module.css";

const highlights = [
  { to: "/concepts/connector", title: "Connect your data", text: "Connect your own data backends." },
  { to: "/concepts/dashboard", title: "Build dashboards", text: "Arrange widgets on dashboards." },
  { to: "/concepts/app", title: "Save apps", text: "Save a dashboard as an app that other people open." },
  { to: "/concepts/agent", title: "Ask the Agent", text: "The Agent reads your dashboards and answers questions about them." },
  { to: "/concepts/mcp-companion", title: "Use your AI tools", text: "The MCP Companion lets AI tools work with your dashboards." },
  { to: "/concepts/plugin", title: "Add widget types", text: "Plugins add new kinds of widgets, such as charts." },
];

const sections = [
  { to: "/quick-start", title: "Quick Start", text: "Run FINOS Workspace, write a backend and put its widget on a dashboard." },
  { to: "/features", title: "Features", text: "What FINOS Workspace does, and how to use each feature." },
  { to: "/concepts", title: "Concepts", text: "What the things you work with are." },
  { to: "/tutorials", title: "Tutorials", text: "Step-by-step guides: build a backend or a plugin, deploy, contribute." },
  { to: "/reference", title: "Reference", text: "Every setting, API, schema and protocol, generated from the code." },
];

export default function Hero() {
  return (
    <>
      <section className={styles.hero}>
        <h1 className={styles.title}>FINOS Workspace</h1>
        <p className={styles.tagline}>
          An open, self-hosted analytics workspace for financial institutions. Connect your data, arrange it in dashboards, and work with it through an AI Agent and your own AI tools.
        </p>
        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/quick-start">
            Quick Start
          </Link>
          <Link className="button button--secondary button--lg" to="/features">
            Features
          </Link>
          <Link className="button button--secondary button--lg" href="https://github.com/finos-labs/finos-workspace">
            GitHub
          </Link>
        </div>
      </section>
      <section className={styles.grid}>
        {highlights.map((item) => (
          <Link key={item.to} to={item.to} className={styles.card}>
            <span className={styles.cardTitle}>{item.title}</span>
            <span>{item.text}</span>
          </Link>
        ))}
      </section>
      <h2 className={styles.heading}>Documentation</h2>
      <section className={styles.grid}>
        {sections.map((item) => (
          <Link key={item.to} to={item.to} className={styles.card}>
            <span className={styles.cardTitle}>{item.title}</span>
            <span>{item.text}</span>
          </Link>
        ))}
      </section>
    </>
  );
}

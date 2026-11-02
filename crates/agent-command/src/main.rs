//! One initialized app-held MCP session, inherited by a command and its children.
//! No relay credentials, configuration files, or owner-identity fallback.
use reqwest::{header::HeaderMap, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, process::Command, time::Duration};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const CONNECTION: &str = "BUZZ_AGENT_CONNECTION";
const PROTOCOL: &str = "2025-06-18";

#[derive(Deserialize, Serialize)]
struct Connection {
    url: String,
    headers: Vec<Header>,
}
#[derive(Deserialize, Serialize)]
struct Header {
    name: String,
    value: String,
}
struct Session {
    client: Client,
    url: Url,
    headers: HeaderMap,
}
impl Session {
    fn open(connection: Connection) -> Result<Self> {
        let url = Url::parse(&connection.url)?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("An app-held loopback connection is required".into());
        }
        let mut headers = HeaderMap::new();
        for header in connection.headers {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(header.name.as_bytes())?,
                header.value.parse()?,
            );
        }
        Ok(Self {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(60))
                .build()?,
            url,
            headers,
        })
    }
    async fn rpc(&mut self, method: &str, params: Value, notify: bool) -> Result<Value> {
        let mut body = json!({"jsonrpc":"2.0", "method":method, "params":params});
        if !notify {
            body["id"] = json!(1);
        }
        let response = self
            .client
            .post(self.url.clone())
            .headers(self.headers.clone())
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .body(serde_json::to_vec(&body)?)
            .send()
            .await?
            .error_for_status()?;
        if let Some(session) = response.headers().get("mcp-session-id") {
            self.headers.insert("mcp-session-id", session.clone());
            self.headers
                .insert("mcp-protocol-version", PROTOCOL.parse()?);
        }
        let bytes = response.bytes().await?;
        if bytes.is_empty() {
            return Ok(json!({}));
        }
        let reply: Value = serde_json::from_slice(&bytes)?;
        if let Some(error) = reply.get("error") {
            return Err(error.to_string().into());
        }
        Ok(reply.get("result").cloned().ok_or("Missing MCP result")?)
    }
    fn connection(&self) -> Result<String> {
        Ok(serde_json::to_string(&Connection {
            url: self.url.to_string(),
            headers: self
                .headers
                .iter()
                .map(|(name, value)| {
                    Ok(Header {
                        name: name.to_string(),
                        value: value.to_str()?.to_owned(),
                    })
                })
                .collect::<Result<_>>()?,
        })?)
    }
    async fn launch(&mut self, args: &[String]) -> Result<i32> {
        let (program, args) = args.split_first().ok_or("A command is required")?;
        self.rpc(
            "initialize",
            json!({"protocolVersion":PROTOCOL,"capabilities":{},
            "clientInfo":{"name":"buzz-agent-command","version":"1"}}),
            false,
        )
        .await?;
        if !self.headers.contains_key("mcp-session-id") {
            return Err("The agent connection did not provide a session".into());
        }
        self.rpc("notifications/initialized", json!({}), true)
            .await?;
        // The copy is this small CLI, never the GUI or another installed `buzz`.
        // Its directory lives until the whole command exits.
        let directory = tempfile::tempdir()?;
        let buzz = directory
            .path()
            .join(if cfg!(windows) { "buzz.exe" } else { "buzz" });
        std::fs::copy(std::env::current_exe()?, &buzz)?;
        let paths = std::iter::once(directory.path().to_path_buf()).chain(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .collect::<Vec<_>>(),
        );
        let status = Command::new(program)
            .args(args)
            .env(CONNECTION, self.connection()?)
            .env("PATH", std::env::join_paths(paths)?)
            .status()?;
        Ok(status.code().unwrap_or(1))
    }
    async fn call(&mut self, args: &[String]) -> Result<i32> {
        if !self.headers.contains_key("mcp-session-id") {
            return Err("Run buzz inside an agent command".into());
        }
        let tools = self.rpc("tools/list", json!({}), false).await?;
        if args == ["tools"] {
            println!("{}", tools["tools"]);
            return Ok(0);
        }
        let (name, arguments) = arguments(args, &tools)?;
        let result = self
            .rpc(
                "tools/call",
                json!({"name":name,"arguments":arguments}),
                false,
            )
            .await?;
        if let Some(content) = result["content"].as_array() {
            for block in content {
                if let Some(text) = block["text"].as_str() {
                    println!("{text}");
                }
            }
        }
        Ok(i32::from(result["isError"] == true))
    }
}
fn arguments(args: &[String], catalog: &Value) -> Result<(String, Value)> {
    let explicit = args.first().is_some_and(|arg| arg == "call");
    let (name, rest) = args[usize::from(explicit)..].split_first().ok_or(
        "Usage: buzz tools | buzz <tool> --field value | buzz call <tool> '<JSON object>'",
    )?;
    let tool = catalog["tools"]
        .as_array()
        .and_then(|tools| tools.iter().find(|tool| tool["name"] == name.as_str()))
        .ok_or(
            "Unknown agent tool. This is the agent MCP helper; run buzz tools to list commands",
        )?;
    let arguments = if explicit {
        if rest.len() != 1 {
            return Err("Expected one JSON object".into());
        }
        let value: Value = serde_json::from_str(&rest[0])?;
        if !value.is_object() {
            return Err("Tool arguments must be a JSON object".into());
        }
        value
    } else {
        if rest.len() % 2 != 0 {
            return Err("Expected --field value pairs".into());
        }
        let mut values = HashMap::new();
        for pair in rest.as_chunks::<2>().0 {
            let key = pair[0]
                .strip_prefix("--")
                .ok_or("Expected --field value")?
                .replace('-', "_");
            let field = tool["inputSchema"]["properties"]
                .get(&key)
                .ok_or("Unknown tool field")?;
            let value = if field["type"] == "string" {
                json!(pair[1])
            } else {
                serde_json::from_str(&pair[1])?
            };
            values.insert(key, value);
        }
        serde_json::to_value(values)?
    };
    Ok((name.clone(), arguments))
}
fn main() {
    let result = (|| -> Result<i32> {
        let args: Vec<_> = std::env::args().collect();
        // App-bundled bootstrap for contained harnesses. Privileged Bash ignores
        // startup files and imported functions; its path never comes from PATH.
        #[cfg(unix)]
        if args.get(1).is_some_and(|arg| arg == "--shell") {
            use std::os::unix::process::CommandExt;
            return Err(Command::new("/bin/bash")
                .args(["-p", "-c"])
                .args(&args[2..])
                .exec()
                .into());
        }

        let connection = serde_json::from_str(
            &std::env::var(CONNECTION).map_err(|_| "An app-held agent connection is required")?,
        )?;
        let mut session = Session::open(connection)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        if Path::new(&args[0]).file_stem().and_then(|s| s.to_str()) == Some("buzz") {
            runtime.block_on(session.call(&args[1..]))
        } else if args.get(1).is_some_and(|arg| arg == "--launch") {
            runtime.block_on(session.launch(&args[2..]))
        } else {
            Err("Expected --launch command [arguments]".into())
        }
    })();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Buzz agent command: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_non_app_endpoints() {
        for url in [
            "https://example.com/mcp",
            "http://localhost:1234/mcp",
            "http://user@127.0.0.1:1234/mcp",
        ] {
            assert!(Session::open(Connection {
                url: url.into(),
                headers: vec![]
            })
            .is_err());
        }
    }
    #[test]
    fn parses_live_tool_fields_and_refuses_unknown_tools() {
        let tools = json!({"tools":[{"name":"mem_set","inputSchema":{"properties":{"text":{"type":"string"},"count":{"type":"number"}}}}]});
        let args = ["mem_set", "--text", "hello", "--count", "3"].map(str::to_owned);
        assert_eq!(
            arguments(&args, &tools).unwrap(),
            ("mem_set".into(), json!({"text":"hello","count":3}))
        );
        assert!(arguments(&["owner-secret".into()], &tools).is_err());
        assert!(arguments(&["call".into(), "mem_set".into(), "[]".into()], &tools).is_err());
    }
}

import packageJson from "../../package.json" with { type: "json" };

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": `Nexus-Agent/${packageJson.version}`,
		"HTTP-Referer": "https://nexus.agent/",
		"X-OpenRouter-Title": "Nexus-Agent",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}

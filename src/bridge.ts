import { ChildProcess, spawn } from "child_process";
import type { BridgeStatus, DshEvent } from "./types";

export interface BridgeOptions {
	command: string;
	profile: string;
	cwd: string;
	debug?: boolean;
}

export interface BridgeHandlers {
	onEvent: (event: DshEvent) => void;
	onStatus: (status: BridgeStatus, info?: string) => void;
}

/**
 * Owns the long-lived `dsh --profile <profile>` child process and translates
 * its JSONL stdout protocol into typed events. The agent's multi-turn memory
 * lives inside that process, so the bridge stays alive across chats of the UI.
 */
export class DshBridge {
	status: BridgeStatus = "stopped";
	model = "";
	lastStderrTail: string[] = [];

	private child: ChildProcess | null = null;
	private stdoutBuf = "";
	private opts: BridgeOptions | null = null;

	constructor(private handlers: BridgeHandlers) {}

	start(opts: BridgeOptions): void {
		this.stop();
		this.opts = opts;
		this.lastStderrTail = [];
		const shell = process.platform === "win32";
		let child: ChildProcess;
		try {
			child = spawn(opts.command, ["--profile", opts.profile], {
				cwd: opts.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell,
			});
		} catch (err) {
			this.status = "stopped";
			this.handlers.onStatus("stopped", `spawn failed: ${String(err)}`);
			return;
		}
		this.child = child;
		this.status = "connecting";
		this.handlers.onStatus("connecting");

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			this.stdoutBuf += chunk;
			let nl: number;
			while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
				const line = this.stdoutBuf.slice(0, nl);
				this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
				this.handleLine(line);
			}
		});

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			for (const raw of chunk.split(/\r?\n/)) {
				const line = raw.trim();
				if (!line) continue;
				this.lastStderrTail.push(line);
				if (this.lastStderrTail.length > 20) this.lastStderrTail.shift();
				if (opts.debug) console.debug("[deepshian stderr]", line);
			}
		});

		child.on("error", (err) => {
			this.handleDeath(`process error: ${err.message}`);
		});
		child.on("exit", (code) => {
			if (this.child === child && this.status !== "stopped") {
				this.handleDeath(
					`exited with code ${String(code)}${
						code === 0 ? "" : `. Last stderr:\n${this.lastStderrTail.join("\n")}`
					}`,
				);
			}
		});
	}

	/** Send one user prompt. Safe even before the first `ready` line arrives. */
	send(prompt: string, mode: string): boolean {
		return this.writeLine(JSON.stringify({ prompt, mode }));
	}

	/** Send a control command (list_models / set_model / list_sessions / open_session). */
	sendCommand(command: Record<string, unknown>): boolean {
		return this.writeLine(JSON.stringify({ ...command, cmd: command.cmd ?? "" }));
	}

	private writeLine(line: string): boolean {
		const stdin = this.child?.stdin;
		if (!stdin || !this.child || this.child.exitCode != null) return false;
		try {
			stdin.write(line + "\n");
		} catch {
			return false;
		}
		return true;
	}

	stop(): void {
		if (this.child) {
			try {
				this.child.kill();
			} catch {
				/* already gone */
			}
			this.child = null;
		}
		this.status = "stopped";
		this.model = "";
		this.handlers.onStatus("stopped");
	}

	get alive(): boolean {
		return this.child != null && this.child.exitCode == null;
	}

	private handleLine(raw: string): void {
		const line = raw.trim();
		if (!line) return;
		let event: DshEvent;
		try {
			event = JSON.parse(line) as DshEvent;
		} catch {
			if (this.opts?.debug) console.debug("[deepshian unparsed]", line);
			return;
		}
		switch (event.t) {
			case "ready":
				this.model = event.model ?? "";
				this.status = "ready";
				this.handlers.onStatus("ready", event.model);
				break;
			case "turn_start":
				this.status = "running";
				this.handlers.onStatus("running");
				break;
			case "turn_end":
			case "error":
				if (this.status === "running") {
					this.status = "ready";
					this.handlers.onStatus("ready", this.model);
				}
				break;
			default:
				break;
		}
		this.handlers.onEvent(event);
	}

	private handleDeath(info: string): void {
		if (this.status === "stopped") return;
		this.stop();
		this.handlers.onStatus("stopped", info);
	}
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BRIDGE_FILE,
  detectProfile,
  dshHome,
  installProfile,
  patchPathHealthy,
  profileDir,
} from "../src/profile/install";

const PROFILE = "deepshian";
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dsh-test-"));
  savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("profile/install", () => {
  it("resolves dsh home from DSH_HOME over the default", () => {
    expect(dshHome()).toBe(home);
    delete process.env.DSH_HOME;
    expect(dshHome()).not.toBe(home);
  });

  it("writes all four profile files with a machine-specific patch", () => {
    installProfile(PROFILE);
    const dir = profileDir(PROFILE);
    for (const f of ["package.json", "cordis.yml", BRIDGE_FILE, "cordis.patch.yml"]) {
      expect(readFileSync(join(dir, f), "utf8").length).toBeGreaterThan(0);
    }
    const patch = readFileSync(join(dir, "cordis.patch.yml"), "utf8");
    expect(patch).toContain(`file:///${join(dir, BRIDGE_FILE).replace(/\\/g, "/")}`);
  });

  it("patchPathHealthy: true right after install", () => {
    installProfile(PROFILE);
    expect(patchPathHealthy(PROFILE)).toBe(true);
  });

  it("patchPathHealthy: false when the patch points elsewhere", () => {
    installProfile(PROFILE);
    const file = join(profileDir(PROFILE), "cordis.patch.yml");
    writeFileSync(file, "name: file:///C:/Someone/Else/deepshian-bridge.mjs\n");
    expect(patchPathHealthy(PROFILE)).toBe(false);
  });

  it("patchPathHealthy: false when the profile is missing", () => {
    expect(patchPathHealthy(PROFILE)).toBe(false);
  });

  it("detectProfile: false before install, true after", () => {
    expect(detectProfile(PROFILE)).toBe(false);
    installProfile(PROFILE);
    expect(detectProfile(PROFILE)).toBe(true);
  });
});
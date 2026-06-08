import type { ProjectInfo } from "./types.js";
import { readText, writeText } from "./io.js";
import { statedPaths } from "./paths.js";
import { fieldValue } from "./markdown.js";

/** Read `.stated/project.md` into a structured {@link ProjectInfo}. */
export function readProject(root: string): ProjectInfo {
  const md = readText(statedPaths(root).project);
  return {
    name: fieldValue(md, "Name"),
    description: fieldValue(md, "Description"),
    architecture: fieldValue(md, "Architecture"),
    currentStatus: fieldValue(md, "Current Status"),
  };
}

/** Render a {@link ProjectInfo} back to the canonical `project.md` layout. */
export function renderProject(info: ProjectInfo): string {
  return [
    "# Project",
    "",
    `Name: ${info.name}`,
    "",
    `Description: ${info.description}`,
    "",
    `Architecture: ${info.architecture}`,
    "",
    `Current Status: ${info.currentStatus}`,
    "",
  ].join("\n");
}

/** Persist a {@link ProjectInfo} to `.stated/project.md`. */
export function writeProject(root: string, info: ProjectInfo): void {
  writeText(statedPaths(root).project, renderProject(info));
}

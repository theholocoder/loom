// A Project's avatar: what the user set, or its initials, on its colour.
import type { CSSProperties } from 'react';
import type { Project } from '../shared/api';
import { avatarText, type ProjectColor } from '../shared/projects';

/** Project `project`'s colour, the same wherever it shows: a `--proj-*` token, in the shown theme's step. */
export function projectColor(project: { color: ProjectColor }): string {
  return `var(--proj-${project.color})`;
}

/** The ink that reads better on Project `project`'s colour, white or near-black, for a label on it. */
export function projectInk(project: { color: ProjectColor }): string {
  return `var(--proj-${project.color}-ink)`;
}

export function ProjectAvatar({ project, size }: { project: Pick<Project, 'name' | 'color' | 'avatar'>; size: number }) {
  // Its label in whichever ink reads better on its colour.
  const style: CSSProperties = { width: size, height: size, background: projectColor(project), color: projectInk(project), fontSize: size * 0.38 };
  return (
    <span className="proj-avatar" aria-hidden style={style}>
      {avatarText(project)}
    </span>
  );
}

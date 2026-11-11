// A Project's avatar: its initials on one of the categorical colours, picked by id.
import type { Project } from '../shared/api';

/** Project avatar colours, the prototype's categorical slots, picked by Project id. */
const PROJECT_COLORS = ['var(--p1)', 'var(--p2)', 'var(--p3)'];

/** The categorical colour of Project `project`, the same wherever it shows. */
export function projectColor(project: Pick<Project, 'id'>): string {
  return PROJECT_COLORS[project.id % PROJECT_COLORS.length]!;
}

export function ProjectAvatar({ project, size }: { project: Project; size: number }) {
  const background = projectColor(project);
  return (
    <span className="proj-avatar" aria-hidden style={{ width: size, height: size, background, fontSize: size * 0.38 }}>
      {project.name.slice(0, 2).toUpperCase()}
    </span>
  );
}

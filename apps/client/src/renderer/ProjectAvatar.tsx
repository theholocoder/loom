// A Project's avatar: its initials on one of the categorical colours, picked by id.
import type { Project } from '../shared/api';

/** Project avatar colours, the prototype's categorical slots, picked by Project id. */
const PROJECT_COLORS = ['var(--p1)', 'var(--p2)', 'var(--p3)'];

export function ProjectAvatar({ project, size }: { project: Project; size: number }) {
  const background = PROJECT_COLORS[project.id % PROJECT_COLORS.length];
  return (
    <span className="proj-avatar" aria-hidden style={{ width: size, height: size, background, fontSize: size * 0.38 }}>
      {project.name.slice(0, 2).toUpperCase()}
    </span>
  );
}

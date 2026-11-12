// Picking the Project a new Session starts in: a modal centred on the window,
// its filter keeping the focus while the arrow keys move the highlight
// (aria-activedescendant). Themed like the popovers (`.popover`, popover.css).
import { useEffect, useId, useRef, useState } from 'react';
import type { Project } from '../shared/api';
import { stepIndex } from './Popover';
import { ProjectAvatar } from './ProjectAvatar';

/** The Projects whose name or checkout path contains the filter, ignoring case. */
export function filterProjects(projects: Project[], filter: string): Project[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((p) => p.name.toLowerCase().includes(needle) || p.checkout.path.toLowerCase().includes(needle));
}

/**
 * `highlightedId` is the Project highlighted at first, if listed; else the
 * first. Escape or a click on the backdrop closes it; the caller puts focus
 * back on its trigger.
 */
export function ProjectPicker({ projects, highlightedId, onPick, onClose }: { projects: Project[]; highlightedId?: number; onPick: (project: Project) => void; onClose: () => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(() => Math.max(0, projects.findIndex((p) => p.id === highlightedId)));
  const matches = filterProjects(projects, filter);
  const highlighted = matches.length ? stepIndex(active, matches.length) : -1;
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (highlighted < 0) return;
    document.getElementById(optionId(highlighted))?.scrollIntoView?.({ block: 'nearest' });
  });

  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="popover picker-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Pick a Project"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          else if (event.key === 'ArrowDown') setActive(stepIndex(highlighted + 1, matches.length));
          else if (event.key === 'ArrowUp') setActive(stepIndex(highlighted - 1, matches.length));
          else if (event.key === 'Enter') {
            if (highlighted >= 0) onPick(matches[highlighted]!);
          } else if (event.key !== 'Tab') return; // The filter is the dialog's only stop: Tab stays put.
          event.preventDefault();
        }}
      >
        <input
          ref={input}
          role="combobox"
          aria-label="Filter Projects"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={highlighted >= 0 ? optionId(highlighted) : undefined}
          placeholder="Filter Projects by name or path…"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setActive(0);
          }}
        />
        <div id={`${id}-list`} role="listbox" aria-label="Projects">
          {matches.map((project, index) => (
            <div
              key={project.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlighted}
              onMouseMove={() => index !== highlighted && setActive(index)}
              // Keep the focus in the filter.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(project)}
            >
              <ProjectAvatar project={project} size={24} />
              <span className="picker-text">
                <b className="picker-name ellipsis">{project.name}</b>
                <span className="picker-path tech muted ellipsis" title={project.checkout.path}>
                  {project.checkout.path}
                </span>
              </span>
            </div>
          ))}
        </div>
        {matches.length === 0 && <div className="muted picker-empty">No matching Project.</div>}
      </div>
    </div>
  );
}

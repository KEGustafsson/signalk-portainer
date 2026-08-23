import type { ReactElement } from 'react';
import { useId } from 'react';
import type {
  DockerContainer,
  DockerImage,
  DockerNetwork,
  DockerNode,
  DockerService,
  DockerVolume,
  Stack,
} from '../types';
import {
  actionLabel,
  actionState,
  actionVariant,
  actionsFor,
  isSelfRow,
  type ContainerAction,
  type ControlState,
} from './control';
import { consoleState } from './consolesession';
import {
  containerName,
  formatAge,
  formatBytes,
  healthColour,
  shortId,
  stateColour,
} from './format';
import {
  isActive,
  stackActionLabel,
  stackActionState,
  stackActionsFor,
  type StackAction,
} from './stackcontrol';

export interface EnvironmentRow {
  id: number;
  name: string;
  type: number;
  url?: string;
  health: string;
  isSelected: boolean;
}

const ENVIRONMENT_TYPES: Record<number, string> = {
  1: 'Local Docker',
  2: 'Agent',
  3: 'Azure ACI',
  4: 'Edge agent',
  5: 'Local Kubernetes',
  6: 'Agent (Kubernetes)',
  7: 'Edge agent (Kubernetes)',
};

export function EmptyRow({ columns, message }: { columns: number; message: string }): ReactElement {
  return (
    <tr>
      <td colSpan={columns} className="text-muted text-center py-3">
        {message}
      </td>
    </tr>
  );
}

/**
 * A button that is offered, and says why it will not act.
 *
 * `disabled` takes a button out of the tab order, which means the `title`
 * carrying the reason can never be reached from a keyboard, and most screen
 * readers stay silent about `title` on a disabled control altogether. The
 * panel's rule is that a disabled button explains itself; carried in `title`
 * alone it explains itself to exactly the operators who can already hover, and
 * to nobody else.
 *
 * So the button stays focusable and is made inert instead: `aria-disabled`
 * tells assistive technology it will not act, `aria-describedby` points at the
 * reason as real text, and the click handler drops the press so nothing can
 * fire through the gap.
 */
export function GatedButton({
  className,
  label,
  reason,
  onPress,
}: {
  className: string;
  /** The visible text, and the accessible name. */
  label: string;
  /** Why the press will be dropped; undefined when it will not be. */
  reason?: string;
  onPress: () => void;
}): ReactElement {
  const describedBy = useId();
  const inert = reason !== undefined;
  return (
    <button
      type="button"
      // Bootstrap dims `.disabled` the same way it dims a real disabled button,
      // which this one deliberately is not: dropping the native attribute to
      // keep the control focusable also dropped the styling, so an inert button
      // looked identical to a live one and a sighted operator pressed it for
      // nothing. `pointer-events` comes back because the class turns it off,
      // and the tooltip below is still the fastest way to read the reason with
      // a mouse.
      className={inert ? `${className} disabled` : className}
      {...(inert ? { style: { pointerEvents: 'auto' as const } } : {})}
      // Named explicitly because the reason is carried inside the button. As a
      // sibling it would sit between two buttons of a btn-group and flatten
      // the group's corners; inside and unnamed it would be read out as part
      // of the button's own name.
      aria-label={label}
      {...(inert ? { 'aria-disabled': true, 'aria-describedby': describedBy } : {})}
      // Kept for the pointer: a tooltip is still the fastest way to read this
      // with a mouse. It is no longer the only way.
      title={reason}
      onClick={() => {
        if (!inert) onPress();
      }}
    >
      {label}
      {inert ? (
        <span id={describedBy} className="visually-hidden">
          {reason}
        </span>
      ) : null}
    </button>
  );
}

function Table({
  headers,
  children,
}: {
  headers: string[];
  children: React.ReactNode;
}): ReactElement {
  return (
    <div className="table-responsive">
      <table className="table table-sm table-hover align-middle">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export interface EnvironmentActionsProps {
  /** Applies the choice. Omitted for a read-only render; no row is then clickable. */
  onSelect?: (id: number) => void;
  /** True while a switch is in flight, so a second click cannot start another. */
  busy?: boolean;
}

/**
 * The environments, and the place the operator picks one.
 *
 * The choice is made here rather than from a picker above the tabs: this table
 * already says what each environment is, where it lives and whether it is
 * answering, which is what the choice actually turns on. A dropdown showed
 * names alone.
 */
export function EnvironmentsTable({
  rows,
  actions,
}: {
  rows: EnvironmentRow[];
  actions?: EnvironmentActionsProps;
}): ReactElement {
  const select = actions?.onSelect;
  return (
    <Table headers={['Name', 'Type', 'Health', 'URL', '']}>
      {rows.length === 0 ? (
        <EmptyRow columns={5} message="No environments" />
      ) : (
        rows.map((row) => {
          // The one already in use is not offered again, and neither is any
          // row while a switch is still going through.
          const choosable = select !== undefined && !row.isSelected && actions?.busy !== true;
          return (
            <tr
              key={row.id}
              className={row.isSelected ? 'table-active' : undefined}
              // The whole row answers, since the whole row is what the operator
              // is reading. The button below is the same choice for anyone
              // driving this from a keyboard.
              {...(choosable
                ? { onClick: () => select(row.id), style: { cursor: 'pointer' } }
                : {})}
            >
              <td>{row.name}</td>
              <td>{ENVIRONMENT_TYPES[row.type] ?? `Type ${row.type}`}</td>
              <td>
                <span className={`badge bg-${healthColour(row.health)}`}>{row.health}</span>
              </td>
              <td className="text-muted small">{row.url ?? '—'}</td>
              <td>
                {row.isSelected ? (
                  <span className="badge bg-primary">selected</span>
                ) : select ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-primary"
                    // Named per row: half a dozen buttons all reading "Select"
                    // tell a screen reader nothing about which one they are.
                    aria-label={`Select ${row.name}`}
                    disabled={actions?.busy === true}
                    onClick={(event) => {
                      // Without this the row underneath answers the same click,
                      // and the same environment is chosen twice.
                      event.stopPropagation();
                      select(row.id);
                    }}
                  >
                    Select
                  </button>
                ) : null}
              </td>
            </tr>
          );
        })
      )}
    </Table>
  );
}

export interface ContainerActionsProps {
  /** What the server says may be offered; absent until /control answers. */
  control?: ControlState;
  /** Id of the container a request is currently in flight for. */
  busyId?: string;
  onAction: (container: DockerContainer, action: ContainerAction) => void;
  /** Opens the log viewer. Reading logs changes nothing, so it is never gated. */
  onLogs?: (container: DockerContainer) => void;
  /** Opens a shell. Gated, and absent entirely on a server that cannot serve one. */
  onConsole?: (container: DockerContainer) => void;
}

export function ContainersTable({
  rows,
  actions,
}: {
  rows: DockerContainer[];
  /** Omitted entirely for a read-only panel; no column is rendered then. */
  actions?: ContainerActionsProps;
}): ReactElement {
  const headers = ['Name', 'State', 'Image', 'Ports', 'Created'];
  if (actions) headers.push('Actions');

  return (
    <Table headers={headers}>
      {rows.length === 0 ? (
        <EmptyRow columns={headers.length} message="No containers" />
      ) : (
        rows.map((row) => (
          <tr key={row.Id}>
            <td>
              {containerName(row.Names)}
              {isSelfRow(actions?.control, row.Id) ? (
                <span className="badge bg-info ms-2" title="The container running Signal K">
                  Signal K
                </span>
              ) : null}
              <div className="text-muted small">{shortId(row.Id)}</div>
            </td>
            <td>
              <span className={`badge bg-${stateColour(row.State)}`}>{row.State}</span>
              <div className="text-muted small">{row.Status}</div>
            </td>
            <td className="small">{row.Image}</td>
            <td className="small">
              {(row.Ports ?? [])
                .filter((port) => port.PublicPort)
                .map((port) => `${port.PublicPort}→${port.PrivatePort}`)
                .join(', ') || '—'}
            </td>
            <td>{formatAge(row.Created)}</td>
            {actions ? (
              <td>
                <ActionButtons row={row} actions={actions} />
              </td>
            ) : null}
          </tr>
        ))
      )}
    </Table>
  );
}

/**
 * The button that opens a shell.
 *
 * Its own component because, unlike Logs, it is gated: a disabled button says
 * why rather than opening a dialog that will be refused.
 */
function ConsoleButton({
  row,
  actions,
}: {
  row: DockerContainer;
  actions: ContainerActionsProps;
}): ReactElement {
  const state = consoleState(actions.control, row);
  return (
    <GatedButton
      className="btn btn-outline-secondary"
      label="Console"
      {...(state.enabled ? {} : { reason: state.reason ?? 'This container cannot be opened' })}
      onPress={() => actions.onConsole?.(row)}
    />
  );
}

function ActionButtons({
  row,
  actions,
}: {
  row: DockerContainer;
  actions: ContainerActionsProps;
}): ReactElement {
  const busy = actions.busyId === row.Id;
  return (
    <div
      className="btn-group btn-group-sm"
      role="group"
      aria-label={`Actions for ${containerName(row.Names)}`}
    >
      {actions.onLogs ? (
        <button
          type="button"
          className="btn btn-outline-secondary"
          // Not disabled while an action is in flight: watching what a restart
          // does to the log is exactly what an operator wants at that moment.
          onClick={() => actions.onLogs?.(row)}
        >
          Logs
        </button>
      ) : null}
      {actions.onConsole ? <ConsoleButton row={row} actions={actions} /> : null}
      {actionsFor(row).map((action) => (
        <GatedButton
          key={action}
          className={`btn btn-${actionVariant(action)}`}
          label={actionLabel(action)}
          // A button that will not act explains itself rather than leaving the
          // operator to guess which setting is in the way — including while
          // this row is waiting on an answer, which is otherwise a button that
          // goes silently dead under the operator's own focus.
          reason={gateReason(actionState(actions.control, row, action), busy, 'container')}
          onPress={() => actions.onAction(row, action)}
        />
      ))}
    </div>
  );
}

export interface StackActionsProps {
  control?: ControlState;
  /** Id of the stack a request is currently in flight for. */
  busyId?: number;
  onAction: (stack: Stack, action: StackAction) => void;
}

export function StacksTable({
  rows,
  actions,
}: {
  rows: Stack[];
  /** Omitted for a read-only panel; no column is rendered then. */
  actions?: StackActionsProps;
}): ReactElement {
  const headers = ['Name', 'Status', 'Type', 'Source'];
  if (actions) headers.push('Actions');

  return (
    <Table headers={headers}>
      {rows.length === 0 ? (
        <EmptyRow columns={headers.length} message="No stacks in this environment" />
      ) : (
        rows.map((row) => (
          <tr key={row.Id}>
            <td>{row.Name}</td>
            <td>
              <span className={`badge bg-${isActive(row) ? 'success' : 'secondary'}`}>
                {isActive(row) ? 'active' : 'inactive'}
              </span>
            </td>
            <td>{row.Type === 1 ? 'Swarm' : row.Type === 3 ? 'Kubernetes' : 'Compose'}</td>
            <td className="small text-muted">{row.GitConfig?.URL ?? 'file'}</td>
            {actions ? (
              <td>
                <StackButtons row={row} actions={actions} />
              </td>
            ) : null}
          </tr>
        ))
      )}
    </Table>
  );
}

function StackButtons({ row, actions }: { row: Stack; actions: StackActionsProps }): ReactElement {
  const busy = actions.busyId === row.Id;
  return (
    <div className="btn-group btn-group-sm" role="group" aria-label={`Actions for ${row.Name}`}>
      {stackActionsFor(row).map((action) => (
        <GatedButton
          key={action}
          className={`btn btn-outline-${action === 'delete' ? 'danger' : 'secondary'}`}
          label={stackActionLabel(action)}
          // A button that will not act carries the setting that would enable it.
          reason={gateReason(stackActionState(actions.control, row, action), busy, 'stack')}
          onPress={() => actions.onAction(row, action)}
        />
      ))}
    </div>
  );
}

/**
 * Why a row's button will not act, or undefined when it will.
 *
 * A request already in flight is a reason like any other, and gets said out
 * loud rather than being expressed as a button that silently stops answering.
 */
function gateReason(
  state: { enabled: boolean; reason?: string },
  busy: boolean,
  subject: 'container' | 'stack',
): string | undefined {
  if (!state.enabled) return state.reason ?? 'This action is not available';
  if (busy) return `Waiting for the last action on this ${subject} to finish`;
  return undefined;
}

export function ImagesTable({ rows }: { rows: DockerImage[] }): ReactElement {
  return (
    <Table headers={['Tags', 'Id', 'Size', 'Created']}>
      {rows.length === 0 ? (
        <EmptyRow columns={4} message="No images" />
      ) : (
        rows.map((row) => (
          <tr key={row.Id}>
            <td className="small">{row.RepoTags?.join(', ') || '<untagged>'}</td>
            <td className="small text-muted">{shortId(row.Id)}</td>
            <td>{formatBytes(row.Size)}</td>
            <td>{formatAge(row.Created)}</td>
          </tr>
        ))
      )}
    </Table>
  );
}

export function VolumesTable({ rows }: { rows: DockerVolume[] }): ReactElement {
  return (
    <Table headers={['Name', 'Driver', 'Mountpoint']}>
      {rows.length === 0 ? (
        <EmptyRow columns={3} message="No volumes" />
      ) : (
        rows.map((row) => (
          <tr key={row.Name}>
            <td>{row.Name}</td>
            <td>{row.Driver}</td>
            <td className="small text-muted">{row.Mountpoint ?? '—'}</td>
          </tr>
        ))
      )}
    </Table>
  );
}

export function NetworksTable({ rows }: { rows: DockerNetwork[] }): ReactElement {
  return (
    <Table headers={['Name', 'Driver', 'Scope', 'Internal']}>
      {rows.length === 0 ? (
        <EmptyRow columns={4} message="No networks" />
      ) : (
        rows.map((row) => (
          <tr key={row.Id}>
            <td>{row.Name}</td>
            <td>{row.Driver}</td>
            <td>{row.Scope}</td>
            <td>{row.Internal ? 'yes' : 'no'}</td>
          </tr>
        ))
      )}
    </Table>
  );
}

export function ServicesTable({ rows }: { rows: DockerService[] }): ReactElement {
  return (
    <Table headers={['Name', 'Mode', 'Replicas', 'Image']}>
      {rows.length === 0 ? (
        <EmptyRow columns={4} message="No services" />
      ) : (
        rows.map((row) => (
          <tr key={row.ID}>
            <td>{row.Spec?.Name ?? shortId(row.ID)}</td>
            <td>{row.Spec?.Mode?.Global ? 'global' : 'replicated'}</td>
            <td>{row.Spec?.Mode?.Replicated?.Replicas ?? '—'}</td>
            <td className="small">{row.Spec?.TaskTemplate?.ContainerSpec?.Image ?? '—'}</td>
          </tr>
        ))
      )}
    </Table>
  );
}

export function NodesTable({ rows }: { rows: DockerNode[] }): ReactElement {
  return (
    <Table headers={['Hostname', 'Role', 'Availability', 'State']}>
      {rows.length === 0 ? (
        <EmptyRow columns={4} message="No nodes" />
      ) : (
        rows.map((row) => (
          <tr key={row.ID}>
            <td>
              {row.Description?.Hostname ?? shortId(row.ID)}
              {row.ManagerStatus?.Leader ? (
                <span className="badge bg-primary ms-2">leader</span>
              ) : null}
            </td>
            <td>{row.Spec?.Role ?? '—'}</td>
            <td>{row.Spec?.Availability ?? '—'}</td>
            <td>
              <span className={`badge bg-${row.Status?.State === 'ready' ? 'success' : 'warning'}`}>
                {row.Status?.State ?? 'unknown'}
              </span>
            </td>
          </tr>
        ))
      )}
    </Table>
  );
}

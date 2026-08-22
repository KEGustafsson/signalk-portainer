import type { ReactElement } from 'react';
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
import { containerName, formatAge, formatBytes, shortId, stateColour } from './format';

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

export function EnvironmentsTable({ rows }: { rows: EnvironmentRow[] }): ReactElement {
  return (
    <Table headers={['Name', 'Type', 'Health', 'URL', '']}>
      {rows.length === 0 ? (
        <EmptyRow columns={5} message="No environments" />
      ) : (
        rows.map((row) => (
          <tr key={row.id}>
            <td>{row.name}</td>
            <td>{ENVIRONMENT_TYPES[row.type] ?? `Type ${row.type}`}</td>
            <td>
              <span className={`badge bg-${row.health === 'up' ? 'success' : 'danger'}`}>
                {row.health}
              </span>
            </td>
            <td className="text-muted small">{row.url ?? '—'}</td>
            <td>{row.isSelected ? <span className="badge bg-primary">selected</span> : null}</td>
          </tr>
        ))
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
      {actionsFor(row).map((action) => {
        const state = actionState(actions.control, row, action);
        return (
          <button
            key={action}
            type="button"
            className={`btn btn-${actionVariant(action)}`}
            // A disabled button explains itself rather than leaving the
            // operator to guess which setting is in the way.
            title={state.reason}
            disabled={!state.enabled || busy}
            onClick={() => actions.onAction(row, action)}
          >
            {actionLabel(action)}
          </button>
        );
      })}
    </div>
  );
}

export function StacksTable({ rows }: { rows: Stack[] }): ReactElement {
  return (
    <Table headers={['Name', 'Status', 'Type', 'Source']}>
      {rows.length === 0 ? (
        <EmptyRow columns={4} message="No stacks in this environment" />
      ) : (
        rows.map((row) => (
          <tr key={row.Id}>
            <td>{row.Name}</td>
            <td>
              <span className={`badge bg-${row.Status === 1 ? 'success' : 'secondary'}`}>
                {row.Status === 1 ? 'active' : 'inactive'}
              </span>
            </td>
            <td>{row.Type === 1 ? 'Swarm' : row.Type === 3 ? 'Kubernetes' : 'Compose'}</td>
            <td className="small text-muted">{row.GitConfig?.URL ?? 'file'}</td>
          </tr>
        ))
      )}
    </Table>
  );
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

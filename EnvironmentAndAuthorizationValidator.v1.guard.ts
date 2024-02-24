import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException
} from '@nestjs/common';

import { ApiKeyConstants } from '@vigil-common/constants/api/key.constants';
import { DeletedStatus } from '@vigil-common/enum/entity/deleted-status.enum';
import { FetchDeletedRecordsAccessLevel } from '@vigil-common/enum/authorization/fetch-deleted-records-access-level';
import { GuardValidationExceptionTypes } from '@vigil-common/enum/exceptions/guard-validation-failed.enum';
import { GuardValidationFailedException } from '@vigil-common/exceptions/guard-validation-failed.exception';
import { EnvironmentExpandFiltersDTO } from '@vigil-environment/dto/request/environment-expand-filters.dto';
import { OrganizationMemberFiltersDTO } from '@vigil-organization/dto/request/organization-member-filter.dto';
import { OrganizationMemberService } from '@vigil-organization/services/organization-member.service';
import { OrganizationType } from '@vigil-organization/enum/organization-type.enum';
import { OrganizationUserRoles } from '@vigil-organization/enum/user-roles.enum';
import { ProjectMemberFiltersDTO } from '@vigil-project/dto/request/project-member-filters.dto';
import { ProjectMemberService } from '@vigil-project/services/project-member.service';
import { ProjectUserRoles } from '../../project/enum/project-user-roles.enum';
import { ProjectService } from '@vigil-project/services/project.service';
import { ProjectType } from '@vigil-project/enum/project-type.enum';
import { ProjectDTO } from '@vigil-project/dto/project.dto';
import { EnvironmentService } from '@vigil-environment/services/environment.service';
import { PaginationFiltersDTO } from '../dto/request/pagination-filters.dto';
import { Reflector } from '@nestjs/core';
import { isUndefined } from 'lodash';
import { validate } from 'uuid';

@Injectable()
export class EnvironmentAndAuthorizationValidatorV1Guard
  implements CanActivate
{
  constructor(
    private reflector: Reflector,
    private readonly organizationMemberService: OrganizationMemberService,
    private readonly projectService: ProjectService,
    private readonly projectMemberService: ProjectMemberService,
    private readonly environmentService: EnvironmentService
  ) {}
  private readonly logger = new Logger(
    EnvironmentAndAuthorizationValidatorV1Guard.name
  );

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    try {
      const { organizationId, projectId, environmentId } =
        await this.getRequestHeaders(request);
      const fetchDeletedRecords = this.reflector.get<boolean>(
        'FetchDeletedRecords',
        context.getHandler()
      );
      this.logger.log(`is Restore Api?, ${fetchDeletedRecords || false}`);
      const deletedStatusFromFilter = request.query['deleted-status'];
      this.logger.debug(
        'Deleted Status from filter :: ' +
          deletedStatusFromFilter +
          ' :: ' +
          JSON.stringify(request)
      );

      const fetchDeletedRecordsLevel: FetchDeletedRecordsAccessLevel =
        this.reflector.get<FetchDeletedRecordsAccessLevel>(
          'FetchDeletedRecordsLevel',
          context.getHandler()
        );
      this.logger.log(
        `Validator initiated to validate project(id)=(${projectId}) with environment(id)=(${environmentId}) in organization(id)=(${organizationId})`
      );

      const disableFeatureForSalesforceType = this.reflector.get<boolean>(
        'DisableFeatureForSalesforceType',
        context.getHandler()
      );

      // Organization Validation
      this.validateOrganizationId(organizationId);

      // Project Validation
      const isProjectValidationOptional = this.reflector.get<boolean>(
        'isProjectValidationOptional',
        context.getHandler()
      );

      // if project id is given and it is not a valid uuid, throw error
      if (projectId && !validate(projectId)) {
        this.logger.error(`Invalid Project id`);
        throw new BadRequestException(`Invalid Project id`);
      }

      if (isProjectValidationOptional === true && !projectId) {
        this.logger.log(
          `Skipped Project Validation since projectId is not available`
        );
        return true;
      }

      if (projectId) {
        this.validateEnvironmentId(
          environmentId,
          projectId,
          organizationId,
          fetchDeletedRecords,
          deletedStatusFromFilter,
          fetchDeletedRecordsLevel
        );
      } else {
        this.logger.error(`Project validation failed :: Invalid Project id`);
        throw new GuardValidationFailedException();
      }
      const userId = request.user.id;
      this.logger.log(
        `Checking whether the user (id)=(${userId}) has the permission in the organization (id)=(${organizationId}) ` +
          `to access (url)=(${request.url}), (method)=(${request.method})`
      );
      const organizationMembers = await this.validateOrganizationMembers(
        organizationId,
        userId,
        fetchDeletedRecords,
        deletedStatusFromFilter,
        fetchDeletedRecordsLevel,
        disableFeatureForSalesforceType
      );
      this.logger.log(
        `Checking whether the user (id)=(${userId}) has the permission in the project (id)=(${projectId}) ` +
          `to access (url)=(${request.url}), (method)=(${request.method})`
      );
      await this.validateProject(
        context,
        projectId,
        userId,
        organizationMembers,
        fetchDeletedRecordsLevel,
        deletedStatusFromFilter,
        disableFeatureForSalesforceType
      );
      return true;
    } catch (error) {
      this.handleError(error);
    }
  }
  private async getRequestHeaders(request: {
    headers: Record<string, string>;
  }) {
    return {
      organizationId: request.headers[ApiKeyConstants.ORGANIZATION_ID],
      projectId: request.headers[ApiKeyConstants.PROJECT_ID],
      environmentId: request.headers[ApiKeyConstants.ENVIRONMENT_ID]
    };
  }
  private validateOrganizationId(organizationId: string) {
    try {
      if (!organizationId || !validate(organizationId)) {
        this.logger.error(`Invalid Organization id`);
        throw new BadRequestException(`Invalid Organization id`);
      }
    } catch (error) {
      this.handleError(error);
    }
  }
  private async validateEnvironmentId(
    environmentId: string,
    projectId: string,
    organizationId: string,
    fetchDeletedRecords: boolean,
    deletedStatusFromFilter: any,
    fetchDeletedRecordsLevel: FetchDeletedRecordsAccessLevel
  ) {
    try {
      if (!environmentId || !validate(environmentId)) {
        this.logger.error(`Invalid Environment id`);
        throw new BadRequestException(`Invalid Environment id`);
      }
      let deletedStatus: DeletedStatus = DeletedStatus.NOT_DELETED;
      const result = await this.environmentService.findEnvironmentId(
        environmentId,
        projectId,
        organizationId
      );

      if (result) {
        this.logger.log(result.message);
      } else {
        this.logger.error(
          `Project(id)=(${projectId}) with environment(id)=(${environmentId}) in organization(id)=(${organizationId}) is not found`
        );
        throw new UnauthorizedException();
      }

      const environmentFilters: EnvironmentExpandFiltersDTO =
        new EnvironmentExpandFiltersDTO();

      if (
        fetchDeletedRecordsLevel === FetchDeletedRecordsAccessLevel.ENVIRONMENT
      ) {
        if (fetchDeletedRecords) {
          deletedStatus = DeletedStatus.WITH_DELETED;
        } else if (!isUndefined(deletedStatusFromFilter)) {
          deletedStatus = deletedStatusFromFilter;
        }
      }

      environmentFilters.deletedStatus = deletedStatus;
    } catch (error) {
      this.handleError(error);
    }
  }
  private async validateOrganizationMembers(
    organizationId: string,
    userId: string,
    fetchDeletedRecords: boolean,
    deletedStatusFromFilter: any,
    fetchDeletedRecordsLevel: FetchDeletedRecordsAccessLevel,
    disableFeatureForSalesforceType: boolean
  ) {
    try {
      let deletedStatus: DeletedStatus = DeletedStatus.NOT_DELETED;
      const organizationMemberFilters: OrganizationMemberFiltersDTO =
        new OrganizationMemberFiltersDTO();

      organizationMemberFilters.organizationId = organizationId;
      organizationMemberFilters.userId = userId;
      organizationMemberFilters.expandOrganization = true;

      if (
        fetchDeletedRecordsLevel === FetchDeletedRecordsAccessLevel.ORGANIZATION
      ) {
        if (fetchDeletedRecords) {
          deletedStatus = DeletedStatus.WITH_DELETED;
        } else if (!isUndefined(deletedStatusFromFilter)) {
          deletedStatus = deletedStatusFromFilter;
        }
      }

      organizationMemberFilters.deletedStatus = deletedStatus;
      const organizationMembers =
        await this.organizationMemberService.findAllOrganizationMembers(
          organizationMemberFilters,
          new PaginationFiltersDTO()
        );

      if (organizationMembers.totalCount === 1) {
        if (
          organizationMembers.data[0].getOrganization().getType() ===
            OrganizationType.SALESFORCE_ONLY &&
          disableFeatureForSalesforceType
        ) {
          throw new UnauthorizedException(
            `The user (id)=(${userId}) is unauthorized to view this feature`
          );
        }
      } else {
        throw new BadRequestException(
          `The user with (id)=(${userId}) is not a part of the organization (id)=(${organizationId})`
        );
      }
      return organizationMembers;
    } catch (error) {
      this.handleError(error);
    }
  }
  private async validateProject(
    context: ExecutionContext,
    projectId: string,
    userId: string,
    organizationMembers: any,
    fetchDeletedRecordsLevel: FetchDeletedRecordsAccessLevel,
    deletedStatusFromFilter: any,
    disableFeatureForSalesforceType: boolean
  ) {
    try {
      const fetchDeletedRecords = this.reflector.get<boolean>(
        'FetchDeletedRecords',
        context.getHandler()
      );
      // get project
      const project: ProjectDTO = await this.getProjectById(projectId);

      const projectMemberFilters = await this.getProjectMemberFilters(
        projectId,
        userId,
        fetchDeletedRecordsLevel,
        fetchDeletedRecords,
        deletedStatusFromFilter
      );

      context.switchToHttp().getRequest().project = project;
      const projectMember =
        await this.projectMemberService.findAllProjectMembers(
          projectMemberFilters,
          new PaginationFiltersDTO()
        );

      // If the user's project type is salesforce, throw unauthorized exception
      if (
        projectMember.totalCount == 1 &&
        project.getType() === ProjectType.SALESFORCE_ONLY &&
        disableFeatureForSalesforceType
      ) {
        throw new UnauthorizedException(
          `The user (id)=(${userId}) is unauthorized to view this feature`
        );
      }

      const projectAccessRole = this.reflector.get<ProjectUserRoles>(
        'projectAccessRole',
        context.getHandler()
      );

      // If the logged-in user is an Owner in the organization, he has all rights in the project as well.
      // So, there is no need for project validation.
      if (
        projectAccessRole &&
        organizationMembers.data[0].getRole() !== OrganizationUserRoles.OWNER
      ) {
        if (projectMember.totalCount > 0) {
          const projectUserRoles: ProjectUserRoles[] = [
            ProjectUserRoles.MANAGER
          ];
          if (projectAccessRole === ProjectUserRoles.MEMBER)
            projectUserRoles.push(ProjectUserRoles.MEMBER);
          if (!projectUserRoles.includes(projectMember.data[0].getRole())) {
            this.logger.error(
              `The user (id)=(${userId}) does not have the permission in the project (id)=(${projectId}) ` +
                `to access (url)=(${
                  context.switchToHttp().getRequest().url
                }), (method)=(${context.switchToHttp().getRequest().method})`
            );
            throw new UnauthorizedException();
          }
        } else {
          throw new UnauthorizedException(
            `The user (id)=(${userId}) is not a part of the project (id)=(${projectId})`
          );
        }
      }

      this.logger.log(
        `Authorization Guard validated successful for user (id)=(${userId}) ` +
          `to access (url)=(${
            context.switchToHttp().getRequest().url
          }), (method)=(${context.switchToHttp().getRequest().method})`
      );
    } catch (error) {
      this.handleError(error);
    }
  }
  private async getProjectById(projectId: string): Promise<ProjectDTO> {
    try {
      return await this.projectService.findProjectById(projectId);
    } catch (err) {
      this.logger.error(
        `Not able to find project (id)=(${projectId}) :: ${err.message}`
      );
      throw new BadRequestException(
        `Not able to find project (id)=(${projectId})`
      );
    }
  }
  private async getProjectMemberFilters(
    projectId: string,
    userId: string,
    fetchDeletedRecordsLevel: FetchDeletedRecordsAccessLevel,
    fetchDeletedRecords: any,
    deletedStatusFromFilter: any
  ): Promise<ProjectMemberFiltersDTO> {
    let deletedStatus: DeletedStatus = DeletedStatus.NOT_DELETED;
    const projectMemberFilters = new ProjectMemberFiltersDTO();
    projectMemberFilters.projectId = projectId;
    projectMemberFilters.userId = userId;
    if (fetchDeletedRecordsLevel === FetchDeletedRecordsAccessLevel.PROJECT) {
      if (fetchDeletedRecords) {
        deletedStatus = DeletedStatus.ONLY_DELETED;
      } else if (!isUndefined(deletedStatusFromFilter)) {
        deletedStatus = deletedStatusFromFilter;
      }
    }
    projectMemberFilters.deletedStatus = deletedStatus;
    return projectMemberFilters;
  }
  private handleError(error: any) {
    this.logger.error(`Validation failed :: ${JSON.stringify(error)}`);
    if (error instanceof UnauthorizedException)
      throw new GuardValidationFailedException(
        GuardValidationExceptionTypes.UNAUTHORIZED_EXCEPTION
      );
    else throw new GuardValidationFailedException();
  }
}

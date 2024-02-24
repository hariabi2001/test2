import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException
} from '@nestjs/common';

import { ApiKeyConstants } from '../constants/api/key.constants';
import { AuthorizationUserRole } from '../enum/authorization/authorization-user-role.enum';
import { DeletedStatus } from '../enum/entity/deleted-status.enum';
import { FetchDeletedRecordsAccessLevel } from '../enum/authorization/fetch-deleted-records-access-level';
import { GuardValidationExceptionTypes } from '../enum/exceptions/guard-validation-failed.enum';
import { GuardValidationFailedException } from '../exceptions/guard-validation-failed.exception';
import { MethodAccessRole } from '../enum/authorization/method-access-role.enum';
import { OrganizationMemberFiltersDTO } from '@vigil-organization/dto/request/organization-member-filter.dto';
import { OrganizationMemberService } from '@vigil-organization/services/organization-member.service';
import { OrganizationType } from '@vigil-organization/enum/organization-type.enum';
import { OrganizationUserRoles } from '@vigil-organization/enum/user-roles.enum';
import { PaginationFiltersDTO } from '../dto/request/pagination-filters.dto';
import { ProjectMemberFiltersDTO } from '@vigil-project/dto/request/project-member-filters.dto';
import { ProjectMemberService } from '@vigil-project/services/project-member.service';
import { ProjectUserRoles } from '../../project/enum/project-user-roles.enum';
import { Reflector } from '@nestjs/core';
import { isUndefined } from 'lodash';
import { ProjectType } from '@vigil-project/enum/project-type.enum';
import { ProjectDTO } from '@vigil-project/dto/project.dto';
import { ProjectService } from '@vigil-project/services/project.service';

@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly organizationMemberService: OrganizationMemberService,
    private readonly projectMemberService: ProjectMemberService,
    private readonly projectService: ProjectService
  ) {}
  private readonly logger = new Logger(AuthorizationGuard.name);

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const accessRole = this.reflector.get<MethodAccessRole>(
        'accessRole',
        context.getHandler()
      );
      const request = context.switchToHttp().getRequest();
      const fetchDeletedRecords = this.reflector.get<DeletedStatus>(
        'FetchDeletedRecords',
        context.getHandler()
      );

      const disableFeatureForSalesforceType = this.reflector.get<boolean>(
        'DisableFeatureForSalesforceType',
        context.getHandler()
      );

      const deletedStatusFromFilter = request.query['deleted-status'];
      this.logger.debug(
        'Deleted Status from filter :: ' + deletedStatusFromFilter
      );

      // this is used to add respective deleted filters based on the controller where it is used
      const fetchDeletedRecordsLevel =
        this.reflector.get<FetchDeletedRecordsAccessLevel>(
          'FetchDeletedRecordsLevel',
          context.getHandler()
        );

      const organizationId =
        request.headers[ApiKeyConstants.ORGANIZATION_ID].toString();
      const userId = request.user.id;
      //A flag variable to check if the logged in user is authorized to access the particular method.
      let isUnAuthorized = false;
      this.logger.log(
        `Checking whether the user (id)=(${userId}) has the permission in the organization (id)=(${organizationId}) ` +
          `to access (url)=(${request.url}), (method)=(${request.method})`
      );

      const organizationMembers = await this.validateOrganizationMembers(
        organizationId,
        userId,
        fetchDeletedRecords,
        deletedStatusFromFilter,
        fetchDeletedRecordsLevel
      );

      if (organizationMembers.totalCount === 1) {
        // If the user's organization type is salesforce , we will be throwing unauthorized exception which will used in places where we don't let the user to see any particular feature
        if (
          organizationMembers.data[0].getOrganization().getType() ===
            OrganizationType.SALESFORCE_ONLY &&
          disableFeatureForSalesforceType
        ) {
          throw new UnauthorizedException(
            `The user (id)=(${userId}) is unauthorized to view this feature`
          );
        }

        // user role & (Bitwise AND) access role equals 0, then unauthorized
        if (
          !(
            AuthorizationUserRole[organizationMembers.data[0].getRole()] &
            accessRole
          )
        ) {
          /**
           * This if-condition fails when the MethodAccessRole is set to OWNER,
           * and the logged in user is not actually a OWNER in the organization.
           * An organization OWNER has all rights in any project in the organization.
           * He can directly add/update/remove members in the project without actually being a Project MANAGER.
           * In these cases, the MethodAccessRole is set to OWNER
           * (if the MethodAccessRole is set to MEMBER, then it could mean to say that any MEMBER in the organization could access the method.
           * But only organization OWNERs and Project MANAGERs have access),
           * but non - OWNERS - the Project MANAGERs can access the methods.
           * So, to check if the user is actually a Project MANAGER, if not OWNER, the flag-isUnAuthorized is set to true,
           * and further it is checked if he is a Project MANAGER, with the help of the ProjectAccessRole decorator.
           */
          isUnAuthorized = true;
        }
      } else {
        throw new BadRequestException(
          `The user with (id)=(${userId}) is not a part of the organization (id)=(${organizationId})`
        );
      }
      const projectId = request.headers[ApiKeyConstants.PROJECT_ID].toString();
      await this.validateProject(
        context,
        projectId,
        userId,
        organizationMembers,
        deletedStatusFromFilter,
        disableFeatureForSalesforceType,
        isUnAuthorized
      );
      return true;
    } catch (error) {
      this.handleError(error);
    }
  }
  private async validateOrganizationMembers(
    organizationId: string,
    userId: string,
    fetchDeletedRecords: any,
    deletedStatusFromFilter: any,
    fetchDeletedRecordsLevel: FetchDeletedRecordsAccessLevel
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
      return organizationMembers;
    } catch (error) {
      this.handleError(error);
    }
  }
  private handleError(error: any) {
    this.logger.error(`Error @ Authorization Guard :: ${error.message}`);
    throw new GuardValidationFailedException(
      GuardValidationExceptionTypes.UNAUTHORIZED_EXCEPTION
    );
  }
  private async validateProject(
    context: ExecutionContext,
    projectId: string,
    userId: string,
    organizationMembers: any,
    deletedStatusFromFilter: any,
    disableFeatureForSalesforceType: boolean,
    isUnAuthorized: boolean
  ) {
    try {
      // this is used to add respective deleted filters based on the controller where it is used
      const fetchDeletedRecordsLevel =
        this.reflector.get<FetchDeletedRecordsAccessLevel>(
          'FetchDeletedRecordsLevel',
          context.getHandler()
        );
      const fetchDeletedRecords = this.reflector.get<boolean>(
        'FetchDeletedRecords',
        context.getHandler()
      );
      const organizationId = context
        .switchToHttp()
        .getRequest()
        .headers[ApiKeyConstants.ORGANIZATION_ID].toString();
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

      this.validateSalesforceType(
        project,
        projectMember,
        userId,
        disableFeatureForSalesforceType
      );

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
          } else {
            isUnAuthorized = false;
          }
        } else {
          throw new UnauthorizedException(
            `The user (id)=(${userId}) is not a part of the project (id)=(${projectId})`
          );
        }
      }
      if (isUnAuthorized) {
        this.logger.error(
          `The user (id)=(${userId}), role=(${organizationMembers.data[0].getRole()}) does not have the permission in the organization (id)=(${organizationId}) ` +
            `to access (url)=(${
              context.switchToHttp().getRequest().url
            }), (method)=(${context.switchToHttp().getRequest().method})`
        );
        throw new UnauthorizedException();
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
  private async validateSalesforceType(
    project: ProjectDTO,
    projectMember: any,
    userId: string,
    disableFeatureForSalesforceType: boolean
  ) {
    try {
      if (
        projectMember.totalCount == 1 &&
        project.getType() === ProjectType.SALESFORCE_ONLY &&
        disableFeatureForSalesforceType
      ) {
        throw new UnauthorizedException(
          `The user (id)=(${userId}) is unauthorized to view this feature`
        );
      }
    } catch (error) {
      this.handleError(error);
    }
  }
}

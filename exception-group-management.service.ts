import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  forwardRef
} from '@nestjs/common';
import {
  addFromDate,
  convertTimeZone,
  formatDate,
  getDifference,
  isBefore,
  isSame,
  subtractFromDate
} from '@vigil-common/utils/moment.utils';
import {
  countBy,
  groupBy,
  isNull,
  isUndefined,
  orderBy,
  round,
  find,
  forEach
} from 'lodash';
import {
  getFilterValuesForAssignedToFilters,
  getFilterValuesForExceptionStatus,
  getFilterValuesForSeverity
} from '@vigil-exception-management/utils/exception-management.utils';

import { ConfigurationDTO } from '@vigil-configuration/dto/configuration.dto';
import { ConfigurationService } from '@vigil-configuration/services/configuration.service';
import { ExceptionLog } from '@vigil-exception-management/entity/exception-log.entity';
import { ExceptionLogDTO } from '@vigil-exception-management/dto/exception-log.dto';
import { ExceptionLogFiltersDTO } from '@vigil-exception-management/dto/request/exception-log-filters.dto';
import { ExceptionLogStatisticsDTO } from '@vigil-exception-management/dto/request/exception-log-statistics.dto';
import { ExceptionManagementDownloadGroupedDTO } from '@vigil-exception-management/dto/exception-management-download-grouped.dto';
import { ExceptionManagementGroupStatisticsDTO } from '@vigil-exception-management/dto/exception-management-statistics-grouped.dto';
import { ExceptionManagementGroupedDTO } from '@vigil-exception-management/dto/exception-management-grouped.dto';
import { ExceptionManagementRepository } from '@vigil-exception-management/repository/exception-management.repository';
import { ExceptionManagementService } from '@vigil-exception-management/service/exception-management.service';
import { FilterConfiguration } from '@vigil-common/dto/filters/filter-configuration.dto';
import { FilterConfigurationKeyConstants } from '@vigil-configuration/constants/filter-configuration.constants';
import { ExceptionGroup } from '@vigil-exception-management/entity/exception-group.entity';
import { GroupedExceptionLogDownloadDTO } from '@vigil-exception-management/dto/request/grouped-exception-download.dto';
import { GroupedExceptionLogFiltersDTO } from '@vigil-exception-management/dto/request/grouped-exception-log-filters.dto';
import { ExceptionGroupManagementRepository } from '@vigil-exception-management/repository/exception-group-management.repository';
import { GroupedExceptionUpdateDTO } from '@vigil-exception-management/dto/request/grouped-exception-update.dto';
import { GroupedExceptionUpdateFiltersDTO } from '@vigil-exception-management/dto/request/grouped-exception-update-filters.dto';
import { MomentConstants } from '@vigil-common/constants/common/moment.constants';
import { PaginatedData } from '@vigil-common/types/paginated-data.type';
import { PaginationFiltersDTO } from '@vigil-common/dto/request/pagination-filters.dto';
import { Severity } from '@vigil-exception-management/enum/severity.enum';
import { Sort } from '@vigil-common/enum/entity/sort.enum';
import { UserMinimalDTO } from '@vigil-user/dto/user-minimal.dto';
import { UpdateExceptionGroupDTO } from '@vigil-exception-management/dto/request/update-exception-group.dto';
import { printableInstance } from '@vigil-common/utils/common.utils';
import { ExceptionGroupDTO } from '@vigil-exception-management/dto/exception-group.dto';
import { EnvironmentService } from '@vigil-environment/services/environment.service';
import { ExceptionGroupResponseDTO } from '@vigil-exception-management/dto/exception-group-response.dto';
import { UpdateExceptionGroupsWithExceptionGroupIdsDTO } from '@vigil-exception-management/dto/request/update-exception-groups-with-exception-group-ids.dto';
import { ProjectMemberDTO } from '@vigil-project/dto/project-member.dto';
import { EnvironmentFiltersDTO } from '@vigil-environment/dto/request/environment-filters.dto';

@Injectable()
export class ExceptionGroupManagementService {
  constructor(
    @Inject(forwardRef(() => ExceptionManagementService))
    public readonly exceptionManagementService: ExceptionManagementService,
    public readonly exceptionManagementRepository: ExceptionManagementRepository,
    public readonly exceptionGroupManagementRepository: ExceptionGroupManagementRepository,
    public readonly environmentService: EnvironmentService,
    private readonly configurationService: ConfigurationService
  ) {}
  private readonly logger = new Logger(ExceptionGroupManagementService.name);

  /**
   * Service function to view statistics of a particular exception group by publicAccessToken
   * @param {string} publicAccessToken - publicAccessToken of the exception to be found
   * @returns {ExceptionLogDTO} - found exception log
   */
  async findStatisticsOfAnExceptionGroupByToken(
    publicAccessToken: string,
    filters: ExceptionLogStatisticsDTO
  ): Promise<ExceptionManagementGroupStatisticsDTO> {
    try {
      this.logger.log(
        `Request to fetch an exception log by (publicAccessToken)=(${publicAccessToken})`
      );

      const foundExceptionLog: ExceptionLogDTO =
        await this.exceptionManagementService
          .findExceptionLogByToken(publicAccessToken)
          .catch(error => {
            throw error;
          });
      this.logger.log(
        `Exception log (publicAccessToken)=(${foundExceptionLog.getPublicAccessToken()}) fetched successfully`
      );

      //setting Filters
      filters.setEnvironmentId(foundExceptionLog.getEnvironmentId());
      filters.setSortCreatedAt(Sort.DESC);

      const exceptionManagementStatisticsGroupedExceptions: ExceptionManagementGroupStatisticsDTO =
        await this.getStatisticsOfAnExceptionGroup(filters).catch(error => {
          throw error;
        });

      return exceptionManagementStatisticsGroupedExceptions;
    } catch (error) {
      this.logger.error(
        `Failed to fetch statistics of exception by (publicAccessToken)=(${publicAccessToken}) :: ${error}`
      );

      throw error;
    }
  }

  /**
   * Service function to get grouped filters options for exception logs
   * @param {string} environmentId - id of the project
   * @returns {FilterConfiguration[]}
   */
  async getGroupedExceptionsFilters(
    environmentId: string
  ): Promise<FilterConfiguration[]> {
    try {
      this.logger.log('Fetching exception group logs filters');

      const filterConfigurations: ConfigurationDTO =
        await this.configurationService.getConfigurationByKey(
          FilterConfigurationKeyConstants.GROUPED_EXCEPTION_LOGS_FILTERS
        );

      const groupedExceptionLogsFilters: FilterConfiguration[] = JSON.parse(
        filterConfigurations.getValue()
      );

      for (const groupedExceptionLogsFilter of groupedExceptionLogsFilters) {
        if (groupedExceptionLogsFilter.filterAttribute === 'severity')
          groupedExceptionLogsFilter.values = getFilterValuesForSeverity();

        if (groupedExceptionLogsFilter.filterAttribute === 'exception-status')
          groupedExceptionLogsFilter.values =
            getFilterValuesForExceptionStatus();

        if (groupedExceptionLogsFilter.filterAttribute === 'assigned-to') {
          const assigneeDetails =
            await this.exceptionManagementService.getAssigneeOfExceptionLogs(
              environmentId
            );
          groupedExceptionLogsFilter.values =
            getFilterValuesForAssignedToFilters(assigneeDetails);
        }
      }

      this.logger.log('Filters fetched successfully');

      return groupedExceptionLogsFilters;
    } catch (error) {
      this.logger.error(
        `Error while fetching filters for exception group logs :: ${error.message}`
      );
      throw new InternalServerErrorException(error);
    }
  }

  /**
   * This Service function is used to get exception management grouped exceptions for an environment
   * @param {GroupedExceptionLogFiltersDTO} groupedExceptionLogFilters - grouped exceptionLog filters
   * @param {PaginationFiltersDTO} pagination - pagination filters
   * @returns {PaginatedData<ExceptionManagementGroupedDTO[]>} - exception management grouped exceptions
   */
  async viewAllGroupedExceptions(
    environmentId: string,
    groupedExceptionLogFilters: GroupedExceptionLogFiltersDTO,
    pagination?: PaginationFiltersDTO
  ): Promise<PaginatedData<ExceptionManagementGroupedDTO[]>> {
    try {
      this.logger.log(
        `Creating exception management grouped exceptions view for environment with (id) = (${environmentId})`
      );
      this.logger.log(
        `Fetching exception management logs for environment with (id) = (${environmentId})`
      );

      const exceptionLogFilters: ExceptionLogFiltersDTO =
        new ExceptionLogFiltersDTO();
      exceptionLogFilters.setEnvironmentId(environmentId);
      exceptionLogFilters.setSortCreatedAt(Sort.DESC);

      if (!isUndefined(groupedExceptionLogFilters.assignedTo)) {
        exceptionLogFilters.setAssignedTo(
          groupedExceptionLogFilters.assignedTo
        );
      }

      if (!isUndefined(groupedExceptionLogFilters.severity)) {
        exceptionLogFilters.setSeverity(groupedExceptionLogFilters.severity);
      }

      if (!isUndefined(groupedExceptionLogFilters.exceptionStatus)) {
        exceptionLogFilters.setExceptionStatus(
          groupedExceptionLogFilters.exceptionStatus
        );
      }

      const allExceptionLogs: PaginatedData<ExceptionLog[]> =
        await this.exceptionManagementRepository
          .findExceptionLogs(exceptionLogFilters)
          .catch(err => {
            this.logger.log(
              `Error fetching exception management logs for environment with (id) = (${environmentId}): ${err.message}`
            );
            throw new InternalServerErrorException(err);
          });
      this.logger.log(
        `Fetched exception management logs for environment with (id) = (${environmentId}) successfully.`
      );

      const groupedExceptionLogs = groupBy(allExceptionLogs.data, item => [
        item.exceptionType,
        item.severity,
        item.exceptionStatus,
        item.assignedTo
      ]);
      let data: ExceptionManagementGroupedDTO[] = [];
      let totalCount = 0;

      if (allExceptionLogs) {
        for (const groupKey in groupedExceptionLogs) {
          const exceptionCount = groupedExceptionLogs[groupKey].length;
          const reportedTime = orderBy(groupedExceptionLogs[groupKey], [
            'reportedAt',
            'desc'
          ]);

          const firstReportedTime = reportedTime[0].reportedAt;
          const latestReportedTime =
            reportedTime[reportedTime.length - 1].reportedAt;

          const exceptionsByDate: { [key: string]: number } = {};
          const exceptionLogsByExceptionTypeInAsc = orderBy(
            groupedExceptionLogs[groupKey],
            ['reportedAt', 'asc']
          );
          exceptionLogsByExceptionTypeInAsc.forEach(exception => {
            if (
              exception.reportedAt >
              subtractFromDate(new Date(), 7, MomentConstants.DAYS).toDate()
            ) {
              const exceptionDate: string = exception.reportedAt
                .toLocaleString()
                .split(',')[0];
              if (exceptionsByDate[exceptionDate]) {
                exceptionsByDate[exceptionDate] =
                  exceptionsByDate[exceptionDate] + 1;
              } else {
                exceptionsByDate[exceptionDate] = 1;
              }
            }
          });

          const groupedExceptions: ExceptionManagementGroupedDTO =
            new ExceptionManagementGroupedDTO()
              .setExceptionType(groupedExceptionLogs[groupKey][0].exceptionType)
              .setExceptionCount(exceptionCount)
              .setFirstReportedTime(firstReportedTime)
              .setLatestReportedTime(latestReportedTime)
              .setResponsesByInterval(exceptionsByDate)
              .setAssignedUser(groupedExceptionLogs[groupKey][0].assignedUser)
              .setExceptionStatus(
                groupedExceptionLogs[groupKey][0].exceptionStatus
              )
              .setSeverity(groupedExceptionLogs[groupKey][0].severity);
          data.push(groupedExceptions);
        }
        if (groupedExceptionLogFilters.sort) {
          data = orderBy(
            data,
            groupedExceptionLogFilters.sort.map(sort => {
              const key = sort.split(' ')[0];
              if (key === 'assignedTo') {
                return obj => {
                  if (!isNull(obj.getAssignedUser())) {
                    return (
                      obj.getAssignedUser().getUser().getFirstName() +
                      obj.getAssignedUser().getUser().getLastName()
                    ).toLowerCase();
                  } else {
                    return obj.getAssignedUser();
                  }
                };
              }
              if (key === 'exceptionType') {
                return obj => obj.getExceptionType().toLowerCase();
              }
              return key;
            }),
            groupedExceptionLogFilters.sort.map(
              sort => sort.split(' ')[1].toLowerCase() as 'asc' | 'desc'
            )
          );
        }

        totalCount = data.length;
        data = data.slice(pagination.skip, pagination.skip + pagination.take);
      }

      this.logger.log(
        `Created exception management report for environment with (id)=(${environmentId}) successfully`
      );

      return { data, totalCount, pagination };
    } catch (error) {
      this.logger.error(
        `Error creating overview report for environment with (id) = (${environmentId}) :: ${error.message}`
      );
      if (error instanceof BadRequestException) {
        throw new BadRequestException(error);
      } else {
        throw new InternalServerErrorException(error);
      }
    }
  }

  /**
   * service function to update exception group
   * @param {GroupedExceptionUpdateFiltersDTO} filters - filters for identifying group
   * @param {GroupedExceptionUpdateDTO} groupedExceptionUpdateDetails - update details
   * @returns {ExceptionLogDTO[]} - updated logs
   */
  async updateGroupedException(
    filters: GroupedExceptionUpdateFiltersDTO,
    groupedExceptionUpdateDetails: GroupedExceptionUpdateDTO,
    environmentId: string
  ): Promise<ExceptionLogDTO[]> {
    return new Promise(async (resolve, reject) => {
      const exceptionLogDTOs: ExceptionLogDTO[] = [];
      this.exceptionManagementRepository
        .updateGroupedException(
          filters,
          groupedExceptionUpdateDetails,
          environmentId
        )
        .then(res => {
          for (const exceptionLog of res) {
            exceptionLogDTOs.push(new ExceptionLogDTO(exceptionLog));
          }
          resolve(exceptionLogDTOs);
        })
        .catch(error => reject(error));
    });
  }

  /**
   * This Service function is used to get exception management statistics of a particular exception group for an environment
   * @param {string} environmentId - id of the environment
   * @param {string} timeZone -time zone of user
   * @param {ExceptionLogStatisticsDTO} filters - date filters
   * @returns {ExceptionManagementStatisticsGroupedDTO} - exception management statistics of a particular exception group
   */
  async getStatisticsOfAnExceptionGroup(
    filters: ExceptionLogStatisticsDTO
  ): Promise<ExceptionManagementGroupStatisticsDTO> {
    try {
      this.logger.log(
        `Creating statistics for exception management of a particular exception group view for environment with (id) = (${filters.environmentId})`
      );
      const groupedExceptions = await this.exceptionManagementRepository
        .getSelectedValuesForStatistics(filters)
        .catch(err => {
          this.logger.log(
            `Error fetching exception management logs for environment with (id) = (${filters.environmentId}): ${err.message}`
          );
          throw new InternalServerErrorException(err);
        });
      this.logger.log(
        `Fetched exception management logs for environment with (id) = (${filters.environmentId}) successfully.`
      );

      if (groupedExceptions.length === 0) {
        this.logger.log(
          `No exceptions found for this particular exception group for environment with (id) = (${filters.environmentId})`
        );
        return new ExceptionManagementGroupStatisticsDTO();
      }

      const reportedTime = orderBy(groupedExceptions, ['reportedAt'], ['asc']);

      const exceptionsByDate: { [key: string]: number } = {};
      const occurrences = countBy(groupedExceptions, 'exceptionMessage');
      const sortedExceptionMessage = orderBy(
        Object.entries(occurrences),
        entry => entry[1],
        'desc'
      );

      reportedTime.forEach(exception => {
        const exceptionDate: string = formatDate(
          exception.reportedAt,
          'DD/MM/YYYY',
          filters.timeZone
        );

        if (exceptionsByDate[exceptionDate]) {
          exceptionsByDate[exceptionDate] += 1;
        } else exceptionsByDate[exceptionDate] = 1;
      });

      const numberOfExceptions = groupedExceptions.length;

      const firstReportedTime = reportedTime[0].reportedAt;
      const latestReportedTime =
        reportedTime[reportedTime.length - 1].reportedAt;

      let dayDiff = getDifference(
        firstReportedTime,
        latestReportedTime,
        MomentConstants.DAYS
      );
      if (dayDiff === 0) dayDiff = 1;

      const filledData: { [key: string]: number } = {};
      let date = firstReportedTime;
      while (
        isBefore(
          new Date(convertTimeZone(date, filters.timeZone).substring(0, 10)),
          new Date(
            convertTimeZone(latestReportedTime, filters.timeZone).substring(
              0,
              10
            )
          )
        ) ||
        isSame(
          new Date(convertTimeZone(date, filters.timeZone).substring(0, 10)),
          new Date(
            convertTimeZone(latestReportedTime, filters.timeZone).substring(
              0,
              10
            )
          )
        )
      ) {
        const currentDate = formatDate(date, 'DD/MM/YYYY', filters.timeZone);
        filledData[currentDate] = !exceptionsByDate[currentDate]
          ? 0
          : exceptionsByDate[currentDate];
        date = addFromDate(date, 1, MomentConstants.DAYS).toDate();
      }
      let averageReported = numberOfExceptions / dayDiff;
      averageReported =
        averageReported - Math.floor(averageReported) >= 0.5
          ? Math.ceil(averageReported)
          : Math.floor(averageReported);

      const statisticsOfGroupedExceptions =
        new ExceptionManagementGroupStatisticsDTO()
          .setExceptionType(groupedExceptions[0].exceptionType)
          .setFirstReportedTime(firstReportedTime)
          .setLatestReportedTime(latestReportedTime)
          .setAverageReported(averageReported)
          .setMostOccurredExceptionMessage({
            message: sortedExceptionMessage[0][0],
            count: sortedExceptionMessage[0][1]
          })
          .setSecondMostOccurredExceptionMessage({
            message:
              sortedExceptionMessage.length > 1
                ? sortedExceptionMessage[1][0]
                : '-',
            count:
              sortedExceptionMessage.length > 1
                ? sortedExceptionMessage[1][1]
                : 0
          })
          .setTotalExceptionCount(groupedExceptions.length)
          .setOthers({
            count:
              sortedExceptionMessage.length > 1
                ? numberOfExceptions -
                  sortedExceptionMessage[0][1] -
                  sortedExceptionMessage[1][1]
                : numberOfExceptions - sortedExceptionMessage[0][1]
          })
          .setResponsesByInterval(filledData);

      return statisticsOfGroupedExceptions;
    } catch (error) {
      this.logger.error(
        `Error creating statistics for exception management of a particular exception group view for environment with (id) = (${filters.environmentId}) :: ${error.message}`
      );
      if (error instanceof BadRequestException) {
        throw new BadRequestException(error);
      } else {
        throw new InternalServerErrorException(error);
      }
    }
  }

  /**
   * This Service function is used to get exception management grouped exceptions of an environment for downloading
   * @param {GroupedExceptionLogDownloadDTO} groupedExceptionLogDownloadFilters - grouped exceptionLog download filters
   * @returns {DataSuccessArrayResponseDTO<ExceptionManagementDownloadGroupedDTO[]>} - exception management grouped exceptions
   */
  async downloadGroupedExceptions(
    environmentId: string,
    groupedExceptionLogFilters: GroupedExceptionLogDownloadDTO
  ): Promise<ExceptionManagementDownloadGroupedDTO[]> {
    try {
      this.logger.log(
        `Creating exception management grouped exceptions view for downloading for environment with (id) = (${environmentId})`
      );
      this.logger.log(
        `Fetching exception management logs for downloading for environment with (id) = (${environmentId})`
      );

      const exceptionLogFilters: ExceptionLogFiltersDTO =
        new ExceptionLogFiltersDTO();
      exceptionLogFilters.setEnvironmentId(environmentId);
      exceptionLogFilters.setSortCreatedAt(Sort.DESC);

      if (!isUndefined(groupedExceptionLogFilters.assignedTo)) {
        exceptionLogFilters.setAssignedTo(
          groupedExceptionLogFilters.assignedTo
        );
      }

      if (!isUndefined(groupedExceptionLogFilters.severity)) {
        exceptionLogFilters.setSeverity(groupedExceptionLogFilters.severity);
      }

      if (!isUndefined(groupedExceptionLogFilters.exceptionStatus)) {
        exceptionLogFilters.setExceptionStatus(
          groupedExceptionLogFilters.exceptionStatus
        );
      }

      if (!isUndefined(groupedExceptionLogFilters.exceptionType)) {
        exceptionLogFilters.setExceptionType(
          groupedExceptionLogFilters.exceptionType
        );
      }
      const allExceptionLogs: PaginatedData<ExceptionLog[]> =
        await this.exceptionManagementRepository
          .findExceptionLogs(exceptionLogFilters)
          .catch(err => {
            this.logger.log(
              `Error fetching exception management logs for environment with (id) = (${environmentId}): ${err.message}`
            );
            throw new InternalServerErrorException(err);
          });
      this.logger.log(
        `Fetched exception management logs for environment with (id) = (${environmentId}) successfully.`
      );

      const groupedExceptionLogs = groupBy(allExceptionLogs.data, item => [
        item.exceptionType,
        item.severity,
        item.exceptionStatus,
        item.assignedTo
      ]);

      const data: ExceptionManagementDownloadGroupedDTO[] = [];

      if (allExceptionLogs) {
        for (const groupKey in groupedExceptionLogs) {
          const exceptionCount = groupedExceptionLogs[groupKey].length;
          const reportedTime = orderBy(groupedExceptionLogs[groupKey], [
            'reportedAt',
            'desc'
          ]);

          const firstReportedTime = formatDate(
            reportedTime[0].reportedAt,
            MomentConstants.DATE_TIME_M,
            groupedExceptionLogFilters.timeZone
          );
          const latestReportedTime = formatDate(
            reportedTime[reportedTime.length - 1].reportedAt,
            MomentConstants.DATE_TIME_M,
            groupedExceptionLogFilters.timeZone
          );

          const exceptionsByDate: { [key: string]: number } = {};
          const exceptionLogsByExceptionTypeInAsc = orderBy(
            groupedExceptionLogs[groupKey],
            ['reportedAt', 'asc']
          );

          exceptionLogsByExceptionTypeInAsc.forEach(exception => {
            if (
              exception.reportedAt >
              subtractFromDate(new Date(), 7, MomentConstants.DAYS).toDate()
            ) {
              const exceptionDate: string = exception.reportedAt
                .toLocaleString()
                .split(',')[0];
              if (exceptionsByDate[exceptionDate]) {
                exceptionsByDate[exceptionDate] =
                  exceptionsByDate[exceptionDate] + 1;
              } else {
                exceptionsByDate[exceptionDate] = 1;
              }
            }
          });

          const groupedExceptions: ExceptionManagementDownloadGroupedDTO =
            new ExceptionManagementDownloadGroupedDTO()
              .setExceptionType(groupedExceptionLogs[groupKey][0].exceptionType)
              .setExceptionCount(exceptionCount)
              .setFirstReportedTime(firstReportedTime)
              .setLatestReportedTime(latestReportedTime)
              .setAssignedUserName(
                !isNull(groupedExceptionLogs[groupKey][0].assignedUser)
                  ? new UserMinimalDTO(
                      groupedExceptionLogs[groupKey][0].assignedUser.user
                    )
                  : null
              )
              .setExceptionStatus(
                groupedExceptionLogs[groupKey][0].exceptionStatus
              )
              .setSeverity(groupedExceptionLogs[groupKey][0].severity);
          data.push(groupedExceptions);
        }
      }

      this.logger.log(
        `Created exception management report for environment with (id)=(${environmentId}) successfully`
      );

      return data;
    } catch (error) {
      this.logger.error(
        `Error creating overview report for environment with (id) = (${environmentId}) :: ${error.message}`
      );
      if (error instanceof BadRequestException) {
        throw new BadRequestException(error);
      } else {
        throw new InternalServerErrorException(error);
      }
    }
  }

  //TODO: Commenting this service function as it is used for mapping existing records in exception logs table with exception group table
  /**
   * This Service function is used to map all exception logs to exception group table
   * @returns {string} - returns a success message if the records are mapped successfully
   */
  async mapRecordsToExceptionGroupTable(): Promise<string> {
    try {
      this.logger.log(`Mapping records to exception group table`);

      // this.logger.log(`Fetching all exception management logs `);

      const environments = await this.environmentService
        .findAllEnvironments(new EnvironmentFiltersDTO())
        .catch(err => {
          throw err;
        });

      for (const environment of environments.data) {
        let stopFlag = false;
        let skip = 0;
        const take = 500;
        while (!stopFlag) {
          this.logger.log(`Skipping ${skip} records, fetching ${take} records`);
          const exceptionLogFilters = new ExceptionLogFiltersDTO();
          exceptionLogFilters.setEnvironmentId(environment.getId());
          const paginationFilters = new PaginationFiltersDTO();
          paginationFilters.skip = skip;
          paginationFilters.take = take;

          this.logger.log(
            `Fetching all exception management logs for environmentId : ${environment.getId()} `
          );

          const allExceptionLogs = await this.exceptionManagementService
            .findExceptionLogs(exceptionLogFilters, paginationFilters)
            .catch(err => {
              this.logger.log(
                `Error fetching exception management logs : ${err.message}`
              );
              throw new InternalServerErrorException(err);
            });

          for (const exceptionLog of allExceptionLogs.data) {
            if (!exceptionLog.getExceptionGroupId()) {
              this.logger.log('Grouping exception');
              const exceptionGroup = await this.logAnExceptionGroup(
                exceptionLog,
                true
              ).catch(err => {
                this.logger.error(
                  `Error logging an exception group  : ${err.message}`
                );
                throw err;
              });

              this.logger.log(
                'Exception group logged, updating group id in exception log'
              );

              await this.exceptionManagementRepository
                .setExceptionGroupId(
                  exceptionGroup.getId(),
                  exceptionLog.getId()
                )
                .catch(err => {
                  this.logger.error(
                    `Error setting exceptionGroupId  : ${err.message}`
                  );
                  throw err;
                });

              this.logger.log(`Setting groupedId to individual log.`);
            } else {
              this.logger.log('Exception is already grouped');
            }
          }

          if (allExceptionLogs.data.length === 0) {
            this.logger.log('No more data to fetch, processing completed.');
            stopFlag = true;
          } else {
            this.logger.log('Fetching next set of records');
            skip = skip + 500;
          }
        }
      }

      return 'Mapped Records Successfully';
    } catch (error) {
      this.logger.error(
        `Error while mapping records to exception group table :: ${error.message}`
      );
      if (error instanceof BadRequestException) {
        throw new BadRequestException(error);
      } else {
        throw new InternalServerErrorException(error);
      }
    }
  }

  /**
   * Service function to add a exception group log
   * @param {ExceptionLogDTO} exceptionLogDetails - exception Log Details
   * @param {boolean} isNewRecord - whether it is a new record or not
   * @param {boolean} isUpdate - whether it is a update or not
   * @returns {ExceptionGroupDTO} - Exception Group Log DTO
   */
  async logAnExceptionGroup(
    exceptionLogDetails: ExceptionLogDTO,
    isNewRecord: boolean
  ): Promise<ExceptionGroupDTO> {
    try {
      this.logger.log(`Logging exception group`);

      const exceptionGroup = new ExceptionGroup();

      const existingGroupedException =
        await this.exceptionGroupManagementRepository
          .findExceptionGroupByTypeAndEnvironment(
            exceptionLogDetails.getExceptionType(),
            exceptionLogDetails.getEnvironmentId()
          )
          .catch(err => {
            this.logger.error(
              `Error occurred while fetching exception group:: ${err.message}`
            );
          });

      if (existingGroupedException) {
        if (isNewRecord) {
          existingGroupedException.exceptionCount =
            existingGroupedException.exceptionCount + 1;
        } else {
          existingGroupedException.exceptionCount =
            existingGroupedException.exceptionCount - 1;
        }

        const exceptionGroup = await this.exceptionGroupManagementRepository
          .logAnExceptionGroup(existingGroupedException)
          .catch(err => {
            this.logger.error(`Error while saving exception group`);

            throw err;
          });

        return new ExceptionGroupDTO(exceptionGroup);
      } else {
        exceptionGroup.exceptionGroupType =
          exceptionLogDetails.getExceptionType();
        exceptionGroup.exceptionCount = 1;
        exceptionGroup.preferredSeverity = Severity.CRITICAL;
        exceptionGroup.environmentId = exceptionLogDetails.getEnvironmentId();

        const newExceptionGroup = await this.exceptionGroupManagementRepository
          .logAnExceptionGroup(exceptionGroup)
          .catch(err => {
            this.logger.error(`Error while saving exception group`);

            throw err;
          });

        return new ExceptionGroupDTO(newExceptionGroup);
      }
    } catch (error) {
      this.logger.error(
        `Error while Logging exception group :: ${error.message}`
      );
      if (error instanceof BadRequestException) {
        throw new BadRequestException(error);
      } else {
        throw new InternalServerErrorException(error);
      }
    }
  }

  /**
   * Service function to fetch a exception group log by type
   * @param {string} exceptionGroupType - exceptionGroupType of the exception group to be fetched
   * @returns {ExceptionGroupDTO} - found  exception group log DTO
   */
  async findExceptionGroupByTypeAndEnvironment(
    exceptionGroupType: string,
    environmentId: string
  ): Promise<ExceptionGroupDTO> {
    try {
      this.logger.log(
        `Finding a Exception Group Log by (exceptionGroupType) and (environmentId)=(${exceptionGroupType}) and (${environmentId})`
      );

      const foundExceptionGroup: ExceptionGroup =
        await this.exceptionGroupManagementRepository
          .findExceptionGroupByTypeAndEnvironment(
            exceptionGroupType,
            environmentId
          )
          .catch(err => {
            throw err;
          });
      this.logger.log(
        `Exception Group log (id)=(${foundExceptionGroup.id}) fetched successfully`
      );

      return new ExceptionGroupDTO(foundExceptionGroup);
    } catch (error) {
      this.logger.error(
        `Failed to fetch exception group by (exceptionGroupType) and (environmentId)=(${exceptionGroupType})  and (${environmentId}) :: ${error}`
      );

      throw error;
    }
  }

  /**
   *
   * Service function to update a exception group log by id
   * @param {string} exceptionGroupId -exception group log id
   * @param {UpdateExceptionGroupDTO} exceptionGroupUpdateDetails - update details
   * @returns {ExceptionGroupDTO} - updated exception group log
   */
  async updateExceptionGroupById(
    exceptionGroupId: string,
    exceptionGroupUpdateDetails: UpdateExceptionGroupDTO
  ): Promise<ExceptionGroupDTO> {
    this.logger.log(
      `Request to update a exception group log (id)=(${exceptionGroupId}) :: ${printableInstance(
        exceptionGroupUpdateDetails
      )}`
    );
    try {
      // update exception log
      const updatedGroupedExceptionLog =
        await this.exceptionGroupManagementRepository
          .updateExceptionGroupById(
            exceptionGroupId,
            exceptionGroupUpdateDetails
          )
          .catch(error => {
            this.logger.error(
              `Failed to update exception group log (id)=(${exceptionGroupId})`
            );
            throw error;
          });

      this.logger.log(
        `Exception Group log (id)=(${exceptionGroupId}) updated successfully`
      );

      return new ExceptionGroupDTO(updatedGroupedExceptionLog);
    } catch (error) {
      this.logger.error(
        `Error while updating exception group log (id)=(${exceptionGroupId}) :: ${error.message}`
      );

      throw new BadRequestException(error);
    }
  }

  /**
   * Private Service function to find exception groups by environmentId
   * @param {string} environmentId - environmentId of the exceptions to be found
   * @param {PaginationFiltersDTO} pagination - pagination filters
   * @returns {PaginatedData<ExceptionGroupDTO[]>} - found exception groups
   */
  private findExceptionGroupsByEnvironmentId(
    environmentId: string,
    pagination?: PaginationFiltersDTO
  ): Promise<PaginatedData<ExceptionGroupDTO[]>> {
    return new Promise((resolve, reject) => {
      try {
        this.logger.log(
          `Request to fetch exception groups by (environmentId)=(${environmentId})`
        );

        this.exceptionGroupManagementRepository
          .findExceptionGroupsByEnvironmentId(environmentId, pagination)
          .then((exceptionGroupRecords: PaginatedData<ExceptionGroup[]>) => {
            const exceptionGroupRecordsOfAnEnv: ExceptionGroupDTO[] = [];
            exceptionGroupRecords.data.forEach(
              (exceptionGroup: ExceptionGroup) =>
                exceptionGroupRecordsOfAnEnv.push(
                  new ExceptionGroupDTO(exceptionGroup)
                )
            );
            resolve({
              data: exceptionGroupRecordsOfAnEnv,
              totalCount: exceptionGroupRecords.totalCount,
              pagination: exceptionGroupRecords.pagination
            });
          })
          .catch(error => {
            this.logger.error(
              `Error @ findExceptionGroupsByEnvironmentId :: ${JSON.stringify(
                error
              )}`
            );
            reject(error);
          });

        this.logger.log(
          `Exception groups with (environmentId)=(${environmentId}) fetched successfully`
        );
      } catch (error) {
        this.logger.error(
          `Failed to fetch exception groups with (environmentId)=(${environmentId}) :: ${error}`
        );

        throw error;
      }
    });
  }

  /**
   * Service function to update exception group preference
   * @param {UpdateExceptionGroupsWithExceptionGroupIdsDTO} exceptionGroupUpdateDetails -  exceptionGroupUpdateDetails
   * @param {string} environmentId - id of the environment
   * @returns {string}
   */
  async updateExceptionGroupPreference(
    exceptionGroupUpdateDetails: UpdateExceptionGroupsWithExceptionGroupIdsDTO,
    environmentId: string
  ): Promise<string> {
    try {
      this.logger.log(
        `Updating ExceptionGroup Preference for ids:: ${exceptionGroupUpdateDetails.ids}`
      );
      const updatedExceptionPreference =
        await this.exceptionGroupManagementRepository
          .updateExceptionGroupPreference(
            exceptionGroupUpdateDetails,
            environmentId
          )
          .catch(err => {
            this.logger.error(
              `Error in updateExceptionGroupPreference :: ${err.message}`
            );
            throw err;
          });

      this.logger.log(`Exception Group Preference updated successfully`);

      return updatedExceptionPreference;
    } catch (error) {
      this.logger.error(
        `Error in updateExceptionGroupPreference :: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Service function to find exception groups
   * @param {environmentId} environmentId - environmentId
   * @param {PaginationFiltersDTO} pagination - pagination filters
   * @returns {PaginatedData<ExceptionGroupResponseDTO[]>} - filtered exception groups
   */
  async findExceptionGroups(
    environmentId: string,
    pagination?: PaginationFiltersDTO
  ): Promise<PaginatedData<ExceptionGroupResponseDTO[]>> {
    const foundExceptionGroups = await this.checkEmptyExceptionGroup(
      environmentId,
      pagination
    );

    const exceptionGroupPromises: Promise<PaginatedData<ExceptionLogDTO[]>>[] =
      [];
    foundExceptionGroups.data.forEach(eg => {
      this.logger.debug(
        `Exception log fetching for groupId :: ${eg.getId()} initiated`
      );
      exceptionGroupPromises.push(
        this.exceptionManagementService.findExceptionLogsByExceptionGroupId(
          eg.getId()
        )
      );
    });

    const exceptionGroupResults: PromiseSettledResult<
      PaginatedData<ExceptionLogDTO[]>
    >[] = await Promise.allSettled(exceptionGroupPromises).catch(err => {
      this.logger.log(
        `Error while getting all exception group logs individually :: ${err.message}`
      );
      throw err;
    });

    let exceptionGroupResponse_: ExceptionGroupResponseDTO[] = [];
    forEach(exceptionGroupResults, (egr, index) => {
      const foundExceptionGroupAtIndex = foundExceptionGroups.data[index];
      if (egr.status === 'rejected') {
        this.logger.warn(
          `findExceptionLogsByExceptionGroupId - rejected for ExceptionGroupId :: ${JSON.stringify(
            foundExceptionGroupAtIndex
          )} :: ${egr.reason}`
        );
      } else {
        const exceptionLogsByExceptionGroupId = egr.value;

        const exceptionGroupResponseDTO: ExceptionGroupResponseDTO =
          new ExceptionGroupResponseDTO();
        exceptionGroupResponseDTO.setExceptionGroupId(
          foundExceptionGroupAtIndex.getId()
        );
        exceptionGroupResponseDTO.setExceptionGroupType(
          foundExceptionGroupAtIndex.getExceptionGroupType()
        );
        exceptionGroupResponseDTO.setExceptionCount(
          foundExceptionGroupAtIndex.getExceptionCount()
        );
        exceptionGroupResponseDTO.setPreferredSeverity(
          foundExceptionGroupAtIndex.getPreferredSeverity()
        );
        if (exceptionLogsByExceptionGroupId.totalCount === 0) {
          exceptionGroupResponseDTO.setFirstReportedTime(null);
          exceptionGroupResponseDTO.setLatestReportedTime(null);
          exceptionGroupResponseDTO.setResponsesByInterval(null);
          exceptionGroupResponseDTO.setSeverityCounts(null);
          exceptionGroupResponseDTO.setExceptionStatusCounts(null);
          exceptionGroupResponseDTO.setAssignedTo(null);
        } else {
          const firstReportedTime =
            exceptionLogsByExceptionGroupId.data[0].getReportedAt();
          const latestReportedTime =
            exceptionLogsByExceptionGroupId.data[
              exceptionLogsByExceptionGroupId.data.length - 1
            ].getReportedAt();

          const exceptionsByDate: { [key: string]: number } = {};
          const assignedTo: ProjectMemberDTO[] = [];

          exceptionLogsByExceptionGroupId.data.forEach(exception => {
            if (
              exception.getReportedAt() >
              subtractFromDate(new Date(), 7, MomentConstants.DAYS).toDate()
            ) {
              const exceptionDate: string = exception
                .getReportedAt()
                .toLocaleString()
                .split(',')[0];
              if (exceptionsByDate[exceptionDate]) {
                exceptionsByDate[exceptionDate] =
                  exceptionsByDate[exceptionDate] + 1;
              } else {
                exceptionsByDate[exceptionDate] = 1;
              }
            }

            if (exception.getAssignedTo()) {
              if (!find(assignedTo, exception.getAssignedTo()))
                assignedTo.push(exception.getAssignedTo());
            }
          });

          const uniqueAssignedTo = [...new Set(assignedTo)];

          const severityCounts = {},
            statusCounts = {};

          const groupedExceptionLogsBySeverity = groupBy(
            exceptionLogsByExceptionGroupId.data,
            'severity'
          );

          for (const severity in groupedExceptionLogsBySeverity) {
            severityCounts[severity] = {
              count: groupedExceptionLogsBySeverity[severity].length,
              percentage: round(
                (groupedExceptionLogsBySeverity[severity].length /
                  foundExceptionGroupAtIndex.getExceptionCount()) *
                  100,
                0
              )
            };
          }

          const groupedExceptionLogsByExceptionStatus = groupBy(
            exceptionLogsByExceptionGroupId.data,
            'exceptionStatus'
          );

          for (const exceptionStatus in groupedExceptionLogsByExceptionStatus) {
            statusCounts[exceptionStatus] = {
              count:
                groupedExceptionLogsByExceptionStatus[exceptionStatus].length,
              percentage: round(
                (groupedExceptionLogsByExceptionStatus[exceptionStatus].length /
                  foundExceptionGroupAtIndex.getExceptionCount()) *
                  100,
                0
              )
            };
          }

          this.logger.log(
            `Grouped exception logs to find reported time, assigned to, severity and status counts`
          );

          exceptionGroupResponseDTO.setFirstReportedTime(firstReportedTime);
          exceptionGroupResponseDTO.setLatestReportedTime(latestReportedTime);
          exceptionGroupResponseDTO.setResponsesByInterval(exceptionsByDate);
          exceptionGroupResponseDTO.setSeverityCounts(severityCounts);
          exceptionGroupResponseDTO.setExceptionStatusCounts(statusCounts);
          exceptionGroupResponseDTO.setAssignedTo(uniqueAssignedTo);
        }
        exceptionGroupResponse_.push(exceptionGroupResponseDTO);
        exceptionGroupResponse_ = exceptionGroupResponse_.slice(
          pagination.skip,
          pagination.skip + pagination.take
        );
      }
    });

    return {
      data: exceptionGroupResponse_,
      totalCount: foundExceptionGroups.totalCount,
      pagination: pagination
    };
  }

  /**
   * service function to delete exception group by id
   * @param {String} id - id of the exception group to be deleted
   * @returns {Boolean} - true if recorded deleted successfully
   */

  deleteExceptionGroupById(id: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.exceptionGroupManagementRepository
        .deleteExceptionGroupById(id)
        .then((result: boolean) => {
          resolve(result);
        })
        .catch(error => reject(error));
    });
  }

  /**
   * Service function to update exception count
   * @param {string} exceptionGroup - exceptionGroup to be updated
   * @param {string} environmentId - environmentId
   * @param {number} count - count to be updated
   * @returns {ExceptionGroupDTO} - Exception Group Log DTO
   */
  async updateExceptionCount(
    exceptionGroup: string,
    environmentId: string,
    count: number
  ): Promise<ExceptionGroupDTO> {
    try {
      this.logger.log(
        `Updating exception count for exceptionGroup :: ${exceptionGroup}`
      );

      const existingGroupedException =
        await this.exceptionGroupManagementRepository
          .findExceptionGroupByTypeAndEnvironment(exceptionGroup, environmentId)
          .catch(err => {
            this.logger.error(
              `Error occurred while fetching exception group:: ${err.message}`
            );
          });

      if (existingGroupedException) {
        existingGroupedException.exceptionCount =
          existingGroupedException.exceptionCount - count;

        const updatedExceptionGroup =
          await this.exceptionGroupManagementRepository
            .logAnExceptionGroup(existingGroupedException)
            .catch(err => {
              this.logger.error(`Error while saving exception group`);

              throw err;
            });

        return new ExceptionGroupDTO(updatedExceptionGroup);
      }
    } catch (error) {
      this.logger.error(
        `Error while updating exception count for exceptionGroup : ${exceptionGroup}:: ${error.message}`
      );
      if (error instanceof BadRequestException) {
        throw new BadRequestException(error);
      } else {
        throw new InternalServerErrorException(error);
      }
    }
  }

  async findExceptionGroupSummaryById(
    exceptionGroupId: string
  ): Promise<ExceptionGroupDTO> {
    try {
      this.logger.log(`Get details of an exception group :${exceptionGroupId}`);
      const exceptionGroup = await this.exceptionGroupManagementRepository
        .findExceptionGroupById(exceptionGroupId)
        .catch(err => {
          this.logger.error(
            `Error while fetching exception group with {id}=${exceptionGroup}`,
            err
          );
          throw new BadRequestException(err);
        });
      return new ExceptionGroupDTO(exceptionGroup);
    } catch (error) {
      this.logger.error(
        `Error while fetching exception group with id : ${exceptionGroupId}:: ${error.message}`
      );
      if (error) {
        throw new BadRequestException(error);
      }
    }
  }
  private async checkEmptyExceptionGroup(
    environmentId: string,
    pagination?: PaginationFiltersDTO
  ) {
    this.logger.log(`Request to fetch exception groups `);
    const foundExceptionGroups = await this.findExceptionGroupsByEnvironmentId(
      environmentId,
      pagination
    ).catch(err => {
      this.logger.error(
        `Error while finding exception groups by environmentId :: ${err.message}`
      );
      throw err;
    });

    if (foundExceptionGroups.totalCount === 0) {
      return {
        data: [],
        totalCount: 0,
        pagination: pagination
      };
    }
    return foundExceptionGroups;
  }
}

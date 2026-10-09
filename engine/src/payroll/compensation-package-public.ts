/** Native employer package configuration, approval, assignment and exact preview contracts. */
export { CompensationPackageUnavailableError } from './compensation-package-error.ts';
export {
  listCompensationPackages, getCompensationPackage, getCompensationPackageForSubject, createCompensationPackage, updateCompensationPackage,
  saveCompensationPackageVersion, transitionCompensationPackageVersion,
  saveCompensationPackageAssignment, transitionCompensationPackageAssignment, previewCompensationPackageVersion,
  type CompensationPackageActor, type CompensationPackageRecord, type CompensationPackageVersion,
  type CompensationPackageAssignment, type CompensationPackageAuthorship,
} from "./compensation-package-store.ts";
export {
  compensationPackagePattern,
  type CompensationPackageDefinition, type CompensationPackageInput, type CompensationPackageRule,
  type CompensationPackageEvaluation, type CompensationPackageEvaluationContext,
} from "./compensation-package.ts";
